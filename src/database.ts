// SQLite storage for the data cube — nodes, edges, and (v0.2.0) provenance + persisted conflicts.

import Database from 'better-sqlite3';
import type {
  DataNode,
  DataEdge,
  DataSource,
  AttributeValue,
  Conflict,
} from './types.js';

export class DataDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS data_nodes (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        content TEXT NOT NULL,
        structured TEXT NOT NULL DEFAULT '{}',
        embedding BLOB,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_origin TEXT NOT NULL DEFAULT '',
        source_path TEXT NOT NULL DEFAULT '',
        source_extracted_at TEXT NOT NULL DEFAULT '',
        source_method TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS data_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        evidence TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, type),
        FOREIGN KEY (from_id) REFERENCES data_nodes(id),
        FOREIGN KEY (to_id) REFERENCES data_nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON data_nodes(entity_type);
      CREATE INDEX IF NOT EXISTS idx_nodes_confidence ON data_nodes(confidence);
      CREATE INDEX IF NOT EXISTS idx_nodes_updated ON data_nodes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON data_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON data_edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON data_edges(type);
    `);

    // v0.2.0 (V2-002) cycle-aware tracking + provenance + persisted conflicts.
    // Migrations are idempotent (column adds use try/catch on duplicate; CREATE TABLE IF NOT EXISTS).
    this.addColumnIfMissing('data_nodes', 'created_at_cycle', 'INTEGER NOT NULL DEFAULT -1');
    this.addColumnIfMissing('data_nodes', 'last_updated_cycle', 'INTEGER NOT NULL DEFAULT -1');
    this.addColumnIfMissing('data_nodes', 'name', "TEXT NOT NULL DEFAULT ''");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES data_nodes(id)
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL,
        values_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        resolution_rule TEXT,
        resolved_at_cycle INTEGER,
        resolved_value_json TEXT,
        created_at_cycle INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES data_nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_provenance_entity ON provenance(entity_id);
      CREATE INDEX IF NOT EXISTS idx_provenance_cycle ON provenance(cycle);
      CREATE INDEX IF NOT EXISTS idx_conflicts_entity ON conflicts(entity_id);
      CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
      CREATE INDEX IF NOT EXISTS idx_nodes_created_cycle ON data_nodes(created_at_cycle);
    `);
  }

  /** Idempotent column addition. SQLite throws on duplicate column names; we swallow that case. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    } catch (e) {
      // SQLite reports "duplicate column name" — already migrated. Other errors propagate.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('duplicate column name')) {
        throw e;
      }
    }
  }

  // ── Node Operations ──

  insertNode(node: DataNode, opts?: { cycle?: number; name?: string }): void {
    const cycle = opts?.cycle ?? -1;
    const name = opts?.name ?? '';
    this.db.prepare(`
      INSERT INTO data_nodes
      (id, entity_type, content, structured, embedding, confidence,
       source_origin, source_path, source_extracted_at, source_method,
       version, created_at, updated_at,
       created_at_cycle, last_updated_cycle, name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id,
      node.entity_type,
      node.content,
      JSON.stringify(node.structured),
      node.embedding ? Buffer.from(new Float64Array(node.embedding).buffer) : null,
      node.confidence,
      node.source.origin,
      node.source.path,
      node.source.extracted_at,
      node.source.method,
      node.version,
      node.created_at,
      node.updated_at,
      cycle,
      cycle,
      name,
    );
  }

  getNode(id: string): DataNode | null {
    const row = this.db.prepare('SELECT * FROM data_nodes WHERE id = ?').get(id) as RawNodeRow | undefined;
    return row ? this.deserializeNode(row) : null;
  }

  getNodesByType(type: string): DataNode[] {
    const rows = this.db.prepare('SELECT * FROM data_nodes WHERE entity_type = ? ORDER BY updated_at DESC').all(type) as RawNodeRow[];
    return rows.map(r => this.deserializeNode(r));
  }

  getAllNodes(): DataNode[] {
    const rows = this.db.prepare('SELECT * FROM data_nodes ORDER BY updated_at DESC').all() as RawNodeRow[];
    return rows.map(r => this.deserializeNode(r));
  }

  updateNode(
    id: string,
    updates: Partial<Pick<DataNode, 'content' | 'structured' | 'embedding' | 'confidence' | 'version' | 'updated_at'>> &
      { lastUpdatedCycle?: number; name?: string },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.structured !== undefined) { sets.push('structured = ?'); values.push(JSON.stringify(updates.structured)); }
    if (updates.embedding !== undefined) { sets.push('embedding = ?'); values.push(Buffer.from(new Float64Array(updates.embedding).buffer)); }
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.version !== undefined) { sets.push('version = ?'); values.push(updates.version); }
    if (updates.updated_at !== undefined) { sets.push('updated_at = ?'); values.push(updates.updated_at); }
    if (updates.lastUpdatedCycle !== undefined) { sets.push('last_updated_cycle = ?'); values.push(updates.lastUpdatedCycle); }
    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }

    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE data_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteNode(id: string): void {
    this.db.prepare('DELETE FROM data_edges WHERE from_id = ? OR to_id = ?').run(id, id);
    this.db.prepare('DELETE FROM data_nodes WHERE id = ?').run(id);
  }

  getNodeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM data_nodes').get() as { count: number };
    return row.count;
  }

  // ── Edge Operations ──

  insertEdge(edge: DataEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO data_edges (from_id, to_id, type, weight, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(edge.from_id, edge.to_id, edge.type, edge.weight, edge.evidence, edge.created_at);
  }

  getEdgesFrom(nodeId: string, type?: string): DataEdge[] {
    if (type) {
      return this.db.prepare('SELECT * FROM data_edges WHERE from_id = ? AND type = ?').all(nodeId, type) as DataEdge[];
    }
    return this.db.prepare('SELECT * FROM data_edges WHERE from_id = ?').all(nodeId) as DataEdge[];
  }

  getEdgesTo(nodeId: string, type?: string): DataEdge[] {
    if (type) {
      return this.db.prepare('SELECT * FROM data_edges WHERE to_id = ? AND type = ?').all(nodeId, type) as DataEdge[];
    }
    return this.db.prepare('SELECT * FROM data_edges WHERE to_id = ?').all(nodeId) as DataEdge[];
  }

  getEdgesFor(nodeId: string, type?: string): DataEdge[] {
    if (type) {
      return this.db.prepare('SELECT * FROM data_edges WHERE (from_id = ? OR to_id = ?) AND type = ?').all(nodeId, nodeId, type) as DataEdge[];
    }
    return this.db.prepare('SELECT * FROM data_edges WHERE from_id = ? OR to_id = ?').all(nodeId, nodeId) as DataEdge[];
  }

  getConflictEdges(): DataEdge[] {
    return this.db.prepare("SELECT * FROM data_edges WHERE type = 'conflicts'").all() as DataEdge[];
  }

  deleteEdgesFor(nodeId: string): void {
    this.db.prepare('DELETE FROM data_edges WHERE from_id = ? OR to_id = ?').run(nodeId, nodeId);
  }

  // ── Metadata ──

  getLastUpdated(): string | null {
    const row = this.db.prepare('SELECT MAX(updated_at) as last FROM data_nodes').get() as { last: string | null };
    return row.last;
  }

  getEntityTypes(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT entity_type FROM data_nodes ORDER BY entity_type').all() as { entity_type: string }[];
    return rows.map(r => r.entity_type);
  }

  // ── V2-002 cycle-aware metadata access ──

  /** Read the cycle-aware metadata for a node (created_at_cycle / last_updated_cycle / name). */
  getNodeCycleMeta(id: string): { createdAtCycle: number; lastUpdatedCycle: number; name: string } | null {
    const row = this.db
      .prepare('SELECT created_at_cycle, last_updated_cycle, name FROM data_nodes WHERE id = ?')
      .get(id) as { created_at_cycle: number; last_updated_cycle: number; name: string } | undefined;
    return row
      ? { createdAtCycle: row.created_at_cycle, lastUpdatedCycle: row.last_updated_cycle, name: row.name }
      : null;
  }

  // ── V2-002 Provenance operations ──

  insertProvenance(record: {
    entity_id: string;
    attribute: string;
    value: AttributeValue;
  }): void {
    this.db.prepare(`
      INSERT INTO provenance (entity_id, attribute, value_json, source, cycle, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.entity_id,
      record.attribute,
      JSON.stringify(record.value.value),
      record.value.source,
      record.value.cycle,
      new Date().toISOString(),
    );
  }

  /** Get the latest AttributeValue per attribute for an entity (highest cycle wins). */
  getLatestAttributesForEntity(entityId: string): Record<string, AttributeValue> {
    const rows = this.db
      .prepare(`
        SELECT attribute, value_json, source, cycle FROM provenance
        WHERE entity_id = ?
        ORDER BY cycle DESC
      `)
      .all(entityId) as Array<{ attribute: string; value_json: string; source: string; cycle: number }>;
    const result: Record<string, AttributeValue> = {};
    for (const row of rows) {
      if (!(row.attribute in result)) {
        result[row.attribute] = {
          value: JSON.parse(row.value_json),
          source: row.source,
          cycle: row.cycle,
        };
      }
    }
    return result;
  }

  /** All provenance values ever recorded for one (entityId, attribute). */
  getProvenanceHistory(entityId: string, attribute: string): AttributeValue[] {
    const rows = this.db
      .prepare(`
        SELECT value_json, source, cycle FROM provenance
        WHERE entity_id = ? AND attribute = ?
        ORDER BY cycle ASC
      `)
      .all(entityId, attribute) as Array<{ value_json: string; source: string; cycle: number }>;
    return rows.map((r) => ({ value: JSON.parse(r.value_json), source: r.source, cycle: r.cycle }));
  }

  // ── V2-002 Conflict operations ──

  insertConflict(c: Conflict): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO conflicts
      (id, entity_id, attribute, values_json, status, resolution_rule,
       resolved_at_cycle, resolved_value_json, created_at_cycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id,
      c.entityId,
      c.attribute,
      JSON.stringify(c.values),
      c.status,
      c.resolutionRule ?? null,
      c.resolvedAtCycle ?? null,
      c.resolvedValue !== undefined ? JSON.stringify(c.resolvedValue) : null,
      c.createdAtCycle,
      new Date().toISOString(),
    );
  }

  getConflicts(status?: 'open' | 'resolved'): Conflict[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM conflicts WHERE status = ? ORDER BY created_at_cycle DESC').all(status)
      : this.db.prepare('SELECT * FROM conflicts ORDER BY created_at_cycle DESC').all()) as RawConflictRow[];
    return rows.map((r) => this.deserializeConflict(r));
  }

  getConflict(id: string): Conflict | null {
    const row = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as RawConflictRow | undefined;
    return row ? this.deserializeConflict(row) : null;
  }

  resolveConflict(
    id: string,
    rule: 'most_recent' | 'majority' | 'manual',
    resolvedValue: unknown,
    resolvedAtCycle: number,
  ): void {
    this.db.prepare(`
      UPDATE conflicts
      SET status = 'resolved',
          resolution_rule = ?,
          resolved_at_cycle = ?,
          resolved_value_json = ?
      WHERE id = ?
    `).run(rule, resolvedAtCycle, JSON.stringify(resolvedValue), id);
  }

  countOpenConflicts(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM conflicts WHERE status = 'open'")
      .get() as { count: number };
    return row.count;
  }

  countEdges(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM data_edges').get() as { count: number };
    return row.count;
  }

  // ── Internal ──

  private deserializeNode(row: RawNodeRow): DataNode {
    return {
      id: row.id,
      entity_type: row.entity_type,
      content: row.content,
      structured: JSON.parse(row.structured),
      embedding: row.embedding ? Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8)) : [],
      confidence: row.confidence,
      source: {
        origin: row.source_origin,
        path: row.source_path,
        extracted_at: row.source_extracted_at,
        method: row.source_method,
      },
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private deserializeConflict(row: RawConflictRow): Conflict {
    return {
      id: row.id,
      entityId: row.entity_id,
      attribute: row.attribute,
      values: JSON.parse(row.values_json),
      status: row.status,
      resolutionRule: row.resolution_rule as Conflict['resolutionRule'],
      resolvedAtCycle: row.resolved_at_cycle ?? undefined,
      resolvedValue: row.resolved_value_json ? JSON.parse(row.resolved_value_json) : undefined,
      createdAtCycle: row.created_at_cycle,
    };
  }

  close(): void {
    this.db.close();
  }
}

interface RawNodeRow {
  id: string;
  entity_type: string;
  content: string;
  structured: string;
  embedding: Buffer | null;
  confidence: number;
  source_origin: string;
  source_path: string;
  source_extracted_at: string;
  source_method: string;
  version: number;
  created_at: string;
  updated_at: string;
  // v0.2.0 columns (always present after migration; may be -1 / '' for pre-v0.2.0 rows)
  created_at_cycle?: number;
  last_updated_cycle?: number;
  name?: string;
}

interface RawConflictRow {
  id: string;
  entity_id: string;
  attribute: string;
  values_json: string;
  status: 'open' | 'resolved';
  resolution_rule: string | null;
  resolved_at_cycle: number | null;
  resolved_value_json: string | null;
  created_at_cycle: number;
  created_at: string;
}
