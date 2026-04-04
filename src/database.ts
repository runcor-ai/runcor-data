// SQLite storage for the data cube — nodes and edges

import Database from 'better-sqlite3';
import type { DataNode, DataEdge, DataSource } from './types.js';

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
  }

  // ── Node Operations ──

  insertNode(node: DataNode): void {
    this.db.prepare(`
      INSERT INTO data_nodes
      (id, entity_type, content, structured, embedding, confidence,
       source_origin, source_path, source_extracted_at, source_method,
       version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  updateNode(id: string, updates: Partial<Pick<DataNode, 'content' | 'structured' | 'embedding' | 'confidence' | 'version' | 'updated_at'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.structured !== undefined) { sets.push('structured = ?'); values.push(JSON.stringify(updates.structured)); }
    if (updates.embedding !== undefined) { sets.push('embedding = ?'); values.push(Buffer.from(new Float64Array(updates.embedding).buffer)); }
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.version !== undefined) { sets.push('version = ?'); values.push(updates.version); }
    if (updates.updated_at !== undefined) { sets.push('updated_at = ?'); values.push(updates.updated_at); }

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
}
