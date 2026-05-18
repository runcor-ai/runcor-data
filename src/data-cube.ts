// DataCube — the query and write API for the data cube.
// v0.2.0 (V2-002) adds the V2-shape surface alongside the existing v0.1.x methods:
//   - getEntity(id) — V2-shape Entity (with name, attributes, provenance, cycle-aware tracking)
//   - getStats() — { entities, edges, openConflicts }
//   - listConflicts(status?) — persisted V2-shape Conflicts
//   - queryReality({ goal, drive, relevance? }) — RealitySlice with pre-rendered text
//   - ingest(input: IngestInput) — V2 cycle-aware ingest that writes provenance + persists Conflicts

import { randomUUID } from 'node:crypto';
import { DataDatabase } from './database.js';
import type {
  DataNode,
  DataEdge,
  QueryOptions,
  GraphResult,
  ModelComplete,
  Entity,
  Edge,
  Conflict,
  AttributeValue,
  RealitySlice,
  IngestInput,
  IngestResult,
  DataCubeStats,
  RealityQueryInput,
  ProvenanceRecord,
  RawContent,
} from './types.js';
import { runPipeline } from './pipeline.js';

// Re-export embedding functions from runcor-memory
// These will be dynamically imported to avoid hard compile-time dependency issues
let embedFn: ((text: string, apiKey?: string) => Promise<number[]>) | null = null;
let cosineSimilarityFn: ((a: number[], b: number[]) => number) | null = null;

async function loadEmbeddings(): Promise<void> {
  if (embedFn) return;
  const mod = await import('runcor-memory');
  embedFn = mod.embed;
  cosineSimilarityFn = mod.cosineSimilarity;
}

export class DataCube {
  private db: DataDatabase;
  private openaiApiKey?: string;
  private model?: ModelComplete;

  constructor(options: { dbPath: string; openaiApiKey?: string; model?: ModelComplete }) {
    this.db = new DataDatabase(options.dbPath);
    this.openaiApiKey = options.openaiApiKey;
    this.model = options.model;
  }

  // ── Read Methods ──

  /** Semantic search across the data cube */
  async search(query: string, options?: QueryOptions): Promise<DataNode[]> {
    await loadEmbeddings();
    const queryEmbedding = await embedFn!(query, this.openaiApiKey);
    const allNodes = this.db.getAllNodes();

    const scored = allNodes
      .filter(n => {
        if (options?.type && n.entity_type !== options.type) return false;
        if (options?.minConfidence && n.confidence < options.minConfidence) return false;
        return n.embedding.length > 0;
      })
      .map(node => ({
        node,
        similarity: cosineSimilarityFn!(queryEmbedding, node.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const limit = options?.limit ?? 10;
    return scored.slice(0, limit).map(s => s.node);
  }

  /** Get a single node by ID */
  getById(id: string): DataNode | null {
    return this.db.getNode(id);
  }

  /** Get all nodes of a given type */
  getByType(type: string): DataNode[] {
    return this.db.getNodesByType(type);
  }

  /** Get all edges for a node, optionally filtered by type */
  getEdges(nodeId: string, type?: string): DataEdge[] {
    return this.db.getEdgesFor(nodeId, type);
  }

  /** Traverse the graph from a node to a given depth */
  getRelated(nodeId: string, depth: number = 1): GraphResult {
    const visited = new Set<string>();
    const nodes: DataNode[] = [];
    const edges: DataEdge[] = [];
    const queue: Array<{ id: string; currentDepth: number }> = [{ id: nodeId, currentDepth: 0 }];

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const node = this.db.getNode(id);
      if (!node) continue;
      nodes.push(node);

      if (currentDepth < depth) {
        const nodeEdges = this.db.getEdgesFor(id);
        for (const edge of nodeEdges) {
          edges.push(edge);
          const neighborId = edge.from_id === id ? edge.to_id : edge.from_id;
          if (!visited.has(neighborId)) {
            queue.push({ id: neighborId, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    return { nodes, edges };
  }

  /** Get all unresolved conflicts */
  getConflicts(): Array<{ node: DataNode; conflicts: DataEdge[] }> {
    const conflictEdges = this.db.getConflictEdges();
    const nodeIds = new Set<string>();
    for (const edge of conflictEdges) {
      nodeIds.add(edge.from_id);
      nodeIds.add(edge.to_id);
    }

    const results: Array<{ node: DataNode; conflicts: DataEdge[] }> = [];
    for (const id of nodeIds) {
      const node = this.db.getNode(id);
      if (!node) continue;
      const nodeConflicts = conflictEdges.filter(e => e.from_id === id || e.to_id === id);
      results.push({ node, conflicts: nodeConflicts });
    }
    return results;
  }

  // ── V2-002 V2-shape surface (additive) ──

  /**
   * Get an entity in V2 shape (with `name`, per-attribute `attributes`, `provenance`,
   * and cycle-aware tracking). Aliases `getById` and converts to V2 Entity shape.
   */
  getEntity(id: string): Entity | null {
    const node = this.db.getNode(id);
    if (!node) return null;
    return this.dataNodeToEntity(node);
  }

  /** Cube-level statistics for dashboards (FR-032). */
  getStats(): DataCubeStats {
    return {
      entities: this.db.getNodeCount(),
      edges: this.db.countEdges(),
      openConflicts: this.db.countOpenConflicts(),
    };
  }

  /** List persisted Conflicts. Default: only `open` conflicts (most useful for dashboards). */
  listConflicts(status: 'open' | 'resolved' | 'all' = 'open'): Conflict[] {
    if (status === 'all') return this.db.getConflicts();
    return this.db.getConflicts(status);
  }

  /**
   * Build a RealitySlice from a structured query (V2 prefers this over `query(naturalLanguage)`).
   * Returns entities matching the goal/drive context, relevant edges between them, open conflicts,
   * and pre-rendered text suitable for direct injection into substrate's RealityLayer prompt.
   */
  async queryReality(input: RealityQueryInput): Promise<RealitySlice> {
    // Compose a search query from goal + drive (drive is a label like 'curiosity'; useful as context).
    const queryText = [input.goal ?? '', input.drive ? `(drive: ${input.drive})` : ''].filter(Boolean).join(' ').trim();

    let nodes: DataNode[] = [];
    if (queryText) {
      const minConfidence = input.relevance === 'high' ? 0.7 : 0.0;
      nodes = await this.search(queryText, { limit: 10, minConfidence });
    } else {
      // No structured input → return the most recently updated entities (still bounded).
      nodes = this.db.getAllNodes().slice(0, 10);
    }

    const entities: Entity[] = nodes.map((n) => this.dataNodeToEntity(n));
    const entityIds = new Set(entities.map((e) => e.id));

    // Gather edges between found entities (excluding the legacy 'conflicts' edge type).
    // Dedupe by composite edge key so the same edge isn't included twice when both endpoints
    // are in the slice.
    const relevantEdges: Edge[] = [];
    const seenEdgeKeys = new Set<string>();
    for (const node of nodes) {
      const dataEdges = this.db.getEdgesFor(node.id);
      for (const de of dataEdges) {
        if (de.type === 'conflicts' || !entityIds.has(de.from_id) || !entityIds.has(de.to_id)) continue;
        const key = `${de.from_id}|${de.to_id}|${de.type}`;
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);
        relevantEdges.push(this.dataEdgeToV2Edge(de));
      }
    }

    // Open conflicts touching any of the entities in the slice.
    const allOpen = this.db.getConflicts('open');
    const openConflicts = allOpen.filter((c) => entityIds.has(c.entityId));

    const rendered = renderRealitySliceText({ entities, relevantEdges, openConflicts });

    return { entities, relevantEdges, openConflicts, rendered };
  }

  /**
   * V2-shape ingest. Cycle-aware. Internally:
   *   1. Routes payload through the existing 5-stage pipeline (identify → normalize → relate →
   *      conflict → persist) via runPipeline.
   *   2. Records per-attribute provenance for every structured field on the new/updated entity.
   *   3. Persists any field-level conflicts as Conflict rows (status=open) so dashboards and the
   *      RealityLayer can surface them on subsequent cycles (FR-082).
   *   4. Stamps cycle-aware metadata (created_at_cycle / last_updated_cycle / name) on the entity.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    // ── V2-action-shape fast path ──
    // Recognized V2 action sources skip the LLM pipeline and use deterministic
    // code-based extraction. ~1ms per ingest, no JSON parse failures, real entities + edges.
    // See src/v2-action-extractor.ts header for rationale.
    const { isV2ActionSource, extractFromV2Action } = await import('./v2-action-extractor.js');
    if (isV2ActionSource(input.source)) {
      const extraction = extractFromV2Action(input.source, input.payload, input.cycle);
      if (extraction !== null) {
        return await this.persistExtraction(extraction, input);
      }
      // Unknown V2 action verb → fall through to LLM pipeline
    }

    if (!this.model) {
      throw new Error('[runcor-data] DataCube.ingest requires a `model` to be configured (V2-shape pipeline).');
    }

    const text = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
    const raw: RawContent = {
      text,
      source: {
        origin: input.source,
        path: '',
        extracted_at: new Date().toISOString(),
        method: 'v2-ingest',
      },
    };

    const pipelineResult = await runPipeline(raw, {
      dataCube: this,
      model: this.model,
      openaiApiKey: this.openaiApiKey,
    });
    const node = pipelineResult.node;

    // Stamp cycle-aware metadata + name on the freshly persisted node.
    const derivedName = deriveEntityName(node);
    this.db.updateNode(node.id, {
      lastUpdatedCycle: input.cycle,
      name: derivedName,
    });
    // For brand-new nodes, the createdAtCycle was set to -1 by the migration. Set it to input.cycle
    // if and only if this is an insert (no prior provenance). Heuristic: count provenance rows.
    const priorProvCount = this.db.getProvenanceHistory(node.id, '__init__').length;
    if (priorProvCount === 0) {
      // Use a sentinel attribute '__init__' to record one provenance row marking creation cycle.
      // This avoids needing a separate "is-new-node" check on the database side.
      this.db.insertProvenance({
        entity_id: node.id,
        attribute: '__init__',
        value: { value: derivedName, source: input.source, cycle: input.cycle },
      });
    }

    // Record per-attribute provenance for each structured field.
    for (const [attr, val] of Object.entries(node.structured)) {
      this.db.insertProvenance({
        entity_id: node.id,
        attribute: attr,
        value: { value: val, source: input.source, cycle: input.cycle },
      });
    }

    // Persist field-level conflicts as Conflict rows.
    const persistedConflicts: Conflict[] = [];
    for (const fc of pipelineResult.conflicts.conflicts) {
      const conflictId = randomUUID();
      const c: Conflict = {
        id: conflictId,
        entityId: fc.existing_node_id,
        attribute: fc.field,
        values: [
          { value: fc.existing_value, source: 'existing', cycle: input.cycle },
          { value: fc.new_value, source: input.source, cycle: input.cycle },
        ],
        status: fc.resolution === 'escalate' ? 'open' : 'resolved',
        resolutionRule: fc.resolution === 'escalate' ? null : 'most_recent',
        resolvedAtCycle: fc.resolution === 'escalate' ? undefined : input.cycle,
        resolvedValue: fc.resolution === 'new_wins' ? fc.new_value : fc.resolution === 'existing_wins' ? fc.existing_value : undefined,
        createdAtCycle: input.cycle,
      };
      this.db.insertConflict(c);
      persistedConflicts.push(c);
    }

    return {
      entity: this.dataNodeToEntity(node),
      edges: pipelineResult.edges.map((e) => this.dataEdgeToV2Edge(e)),
      conflicts: persistedConflicts,
    };
  }

  /** Resolve an open conflict programmatically (operator action / automated rule). */
  resolveConflict(
    conflictId: string,
    rule: 'most_recent' | 'majority' | 'manual',
    resolvedValue: unknown,
    cycle: number,
  ): void {
    this.db.resolveConflict(conflictId, rule, resolvedValue, cycle);
  }

  // ── V2-action fast-path persistence ────────────────────────────────────
  //
  // Takes a code-extracted {entities, edges} and persists each, deduping entities
  // by their stable `key` (structured.key field). Returns the primary entity as
  // IngestResult.entity for API compat.

  private async persistExtraction(
    extraction: import('./v2-action-extractor.js').ExtractionResult,
    input: IngestInput,
  ): Promise<IngestResult> {
    const { randomUUID } = await import('node:crypto');
    const now = new Date().toISOString();
    const keyToId = new Map<string, string>();

    for (const ent of extraction.entities) {
      // Dedup: look for existing node with this entity_type whose structured.key matches.
      const existing = this.db.getNodesByType(ent.entity_type).find((n) => {
        const s = n.structured;
        return typeof s === 'object' && s !== null && (s as { key?: unknown }).key === ent.key;
      });

      if (existing) {
        keyToId.set(ent.key, existing.id);
        // Merge structured: new wins for non-undefined values; previous fields preserved otherwise.
        const merged: Record<string, unknown> = { ...existing.structured };
        for (const [k, v] of Object.entries(ent.structured)) {
          if (v !== undefined) merged[k] = v;
        }
        this.db.updateNode(existing.id, {
          structured: merged,
          updated_at: now,
          lastUpdatedCycle: input.cycle,
          name: ent.name,
        });
      } else {
        const id = randomUUID();
        keyToId.set(ent.key, id);
        const node = {
          id,
          entity_type: ent.entity_type,
          content: ent.content,
          structured: ent.structured,
          embedding: [], // V2-action entities are structured; semantic search not the primary access pattern
          confidence: 1.0, // deterministic extraction
          source: {
            origin: input.source,
            path: '',
            extracted_at: now,
            method: 'v2-action-extract',
          },
          version: 1,
          created_at: now,
          updated_at: now,
        };
        this.db.insertNode(node, { cycle: input.cycle, name: ent.name });
        this.db.insertProvenance({
          entity_id: id,
          attribute: '__init__',
          value: { value: ent.name, source: input.source, cycle: input.cycle },
        });
        for (const [attr, val] of Object.entries(ent.structured)) {
          this.db.insertProvenance({
            entity_id: id,
            attribute: attr,
            value: { value: val, source: input.source, cycle: input.cycle },
          });
        }
      }
    }

    // Persist edges
    const persistedEdges: Edge[] = [];
    for (const e of extraction.edges) {
      const fromId = keyToId.get(e.from_key);
      const toId = keyToId.get(e.to_key);
      if (!fromId || !toId) continue;
      const dataEdge = {
        from_id: fromId,
        to_id: toId,
        type: e.type,
        weight: e.weight,
        evidence: e.evidence,
        created_at: now,
      };
      this.db.insertEdge(dataEdge);
      persistedEdges.push(this.dataEdgeToV2Edge(dataEdge));
    }

    // Primary entity is the first one (handler convention)
    const primaryNode = this.db.getNode(keyToId.get(extraction.entities[0]!.key)!);
    if (!primaryNode) throw new Error('persistExtraction: primary node not found after insert');

    return {
      entity: this.dataNodeToEntity(primaryNode),
      edges: persistedEdges,
      conflicts: [],
    };
  }

  // ── V2 / v0.1 conversion helpers ──

  private dataNodeToEntity(node: DataNode): Entity {
    const cycleMeta = this.db.getNodeCycleMeta(node.id);
    const attributesFromProvenance = this.db.getLatestAttributesForEntity(node.id);

    // If no provenance rows exist (legacy v0.1.x data), synthesize attributes from `structured`
    // with cycle=-1 (sentinel for "pre-V2" data).
    const attributes: Record<string, AttributeValue> =
      Object.keys(attributesFromProvenance).length > 0
        ? attributesFromProvenance
        : Object.fromEntries(
            Object.entries(node.structured).map(([k, v]) => [
              k,
              { value: v, source: node.source.origin || 'legacy', cycle: -1 },
            ]),
          );

    // Drop the '__init__' sentinel attribute used only for creation tracking.
    delete attributes.__init__;

    const provenance: ProvenanceRecord[] = [
      {
        cycle: cycleMeta?.createdAtCycle ?? -1,
        action: node.source.method || 'unknown',
        rawSourceUri: node.source.path || undefined,
      },
    ];

    return {
      id: node.id,
      name: cycleMeta?.name || deriveEntityName(node),
      type: node.entity_type,
      attributes,
      provenance,
      createdAtCycle: cycleMeta?.createdAtCycle ?? -1,
      lastUpdatedCycle: cycleMeta?.lastUpdatedCycle ?? -1,
    };
  }

  private dataEdgeToV2Edge(de: DataEdge): Edge {
    return {
      id: `${de.from_id}|${de.to_id}|${de.type}`,
      fromEntityId: de.from_id,
      toEntityId: de.to_id,
      relation: de.type,
      provenance: [
        { cycle: -1, action: de.evidence || 'unknown' },
      ],
    };
  }

  /** Natural language query — uses LLM to interpret and search */
  async query(naturalLanguage: string): Promise<GraphResult> {
    // Start with semantic search
    const nodes = await this.search(naturalLanguage, { limit: 10 });

    // Gather all edges between found nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges: DataEdge[] = [];
    for (const node of nodes) {
      const nodeEdges = this.db.getEdgesFor(node.id);
      for (const edge of nodeEdges) {
        if (nodeIds.has(edge.from_id) && nodeIds.has(edge.to_id)) {
          edges.push(edge);
        }
      }
    }

    return { nodes, edges };
  }

  // ── Write Methods ──

  /** Persist a new entity to the data cube */
  async persist(input: Omit<DataNode, 'id' | 'embedding'>): Promise<DataNode> {
    await loadEmbeddings();

    const id = randomUUID();
    const embedding = await embedFn!(input.content, this.openaiApiKey);

    const node: DataNode = {
      ...input,
      id,
      embedding,
    };

    this.db.insertNode(node);
    return node;
  }

  /** Add an edge between two entities */
  addEdge(input: Omit<DataEdge, 'created_at'>): void {
    const edge: DataEdge = {
      ...input,
      created_at: new Date().toISOString(),
    };
    this.db.insertEdge(edge);
  }

  /** Update an existing node (increments version) */
  async update(id: string, updates: { content?: string; structured?: Record<string, unknown>; confidence?: number }): Promise<DataNode | null> {
    const existing = this.db.getNode(id);
    if (!existing) return null;

    const updateFields: Parameters<DataDatabase['updateNode']>[1] = {
      version: existing.version + 1,
      updated_at: new Date().toISOString(),
    };

    if (updates.content !== undefined) {
      updateFields.content = updates.content;
      await loadEmbeddings();
      updateFields.embedding = await embedFn!(updates.content, this.openaiApiKey);
    }
    if (updates.structured !== undefined) updateFields.structured = updates.structured;
    if (updates.confidence !== undefined) updateFields.confidence = updates.confidence;

    this.db.updateNode(id, updateFields);
    return this.db.getNode(id);
  }

  // ── Metadata ──

  lastUpdated(): string {
    return this.db.getLastUpdated() ?? new Date().toISOString();
  }

  getEntityTypes(): string[] {
    return this.db.getEntityTypes();
  }

  getNodeCount(): number {
    return this.db.getNodeCount();
  }

  close(): void {
    this.db.close();
  }
}

// ─── V2-002 helpers (file-private) ───────────────────────────────────────

/**
 * Derive a human-readable name from a DataNode. Prefers a `name` field in `structured`,
 * then content's first line (truncated), then falls back to entity_type + id prefix.
 */
function deriveEntityName(node: DataNode): string {
  const fromStructured = node.structured?.['name'] ?? node.structured?.['title'];
  if (typeof fromStructured === 'string' && fromStructured.trim()) return fromStructured.trim();
  const firstLine = node.content?.split('\n')[0]?.trim();
  if (firstLine) return firstLine.slice(0, 80);
  return `${node.entity_type}-${node.id.slice(0, 8)}`;
}

/**
 * Pre-render a RealitySlice as text for substrate's RealityLayer. The substrate's existing
 * `renderRealitySlice` (in runcor-substrate/src/reality.ts) operates on the v0.1.x slice shape;
 * V2 prefers this richer rendering using V2-shape Entity / Edge / Conflict.
 */
function renderRealitySliceText(input: { entities: Entity[]; relevantEdges: Edge[]; openConflicts: Conflict[] }): string {
  const lines: string[] = [];

  if (input.entities.length === 0) {
    return 'REALITY — No relevant entities matched the current goal/drive context.';
  }

  lines.push(`REALITY — Currently relevant from the data cube (${input.entities.length} ${input.entities.length === 1 ? 'entity' : 'entities'}, ${input.relevantEdges.length} ${input.relevantEdges.length === 1 ? 'edge' : 'edges'}, ${input.openConflicts.length} open ${input.openConflicts.length === 1 ? 'conflict' : 'conflicts'}).`);
  lines.push('');
  lines.push('Entities:');

  for (const entity of input.entities) {
    const attrSummary = Object.entries(entity.attributes)
      .slice(0, 4)
      .map(([k, av]) => `${k}=${JSON.stringify(av.value)}`)
      .join(', ');
    const cycleStamp =
      entity.lastUpdatedCycle >= 0 ? ` [cycle ${entity.lastUpdatedCycle}]` : '';
    lines.push(`- ${entity.type} "${entity.name}" [${entity.id.slice(0, 8)}]${cycleStamp}`);
    if (attrSummary) lines.push(`  ${attrSummary}`);
  }

  if (input.relevantEdges.length > 0) {
    lines.push('');
    lines.push('Relationships:');
    for (const edge of input.relevantEdges.slice(0, 10)) {
      lines.push(`- ${edge.fromEntityId.slice(0, 8)} —${edge.relation}→ ${edge.toEntityId.slice(0, 8)}`);
    }
  }

  if (input.openConflicts.length > 0) {
    lines.push('');
    lines.push('Open conflicts (unresolved contradictions):');
    for (const c of input.openConflicts.slice(0, 5)) {
      const valueSummary = c.values
        .map((v) => `${JSON.stringify(v.value)} (cycle ${v.cycle}, source: ${v.source})`)
        .join(' vs ');
      lines.push(`- entity ${c.entityId.slice(0, 8)} attribute "${c.attribute}": ${valueSummary}`);
    }
  }

  return lines.join('\n');
}
