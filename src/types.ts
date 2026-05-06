// runcor-data types — Data Agent and Data Cube
//
// v0.2.0 (V2-002 shape alignment) — adds the V2-shaped surface alongside the existing
// DataNode/DataEdge primitives:
//   - AttributeValue (per-attribute provenance: { value, source, cycle })
//   - ProvenanceRecord (action audit trail per entity/edge)
//   - Entity (V2-shape: id, name, type, attributes, provenance, createdAtCycle, lastUpdatedCycle)
//   - Edge (V2-shape with fromEntityId/toEntityId/relation naming)
//   - Conflict (persisted entity, NOT transient — gets a row in the new `conflicts` table)
//   - RealitySlice (with `rendered: string` for substrate's Reality layer)
//   - IngestInput / IngestResult (cycle-aware V2 ingest signature)
// V0.1.x types (DataNode, DataEdge, ConflictResult, RawContent, etc.) are preserved unchanged
// for backwards compat. Convert between them via the adapter helpers in src/adapters.ts.

// ── V2-002 Shapes (additive) ──

/**
 * Per-attribute value with provenance. The cycle field is the V2 cycle counter at the time
 * the assertion was made; the source is the action / actor that produced the assertion.
 * FR-082 (conflict surfacing) depends on `cycle` granularity at the attribute level.
 */
export interface AttributeValue {
  value: unknown;
  source: string;
  cycle: number;
}

/** A provenance entry — what action / cycle produced an entity or edge. */
export interface ProvenanceRecord {
  cycle: number;
  action: string;
  rawSourceUri?: string;
}

/**
 * V2-shape Entity. Overlaps semantically with `DataNode` but exposes a different surface
 * (name field, per-attribute provenance, cycle-aware tracking). V2 reads via this shape;
 * internal storage is still the data_nodes + provenance tables.
 */
export interface Entity {
  id: string;
  name: string;
  type: string;
  attributes: Record<string, AttributeValue>;
  provenance: ProvenanceRecord[];
  createdAtCycle: number;
  lastUpdatedCycle: number;
}

/** V2-shape Edge with V2 naming (fromEntityId / toEntityId / relation). */
export interface Edge {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  attributes?: Record<string, AttributeValue>;
  provenance: ProvenanceRecord[];
}

/**
 * Persisted Conflict (V2-002). Replaces the transient `ConflictResult` for cases where the
 * cube needs to surface unresolved contradictions in subsequent cycles (FR-082, dashboard /data).
 * `ConflictResult` is preserved as a per-ingest pipeline output; `Conflict` is the persistent row.
 */
export interface Conflict {
  id: string;
  entityId: string;
  attribute: string;
  values: AttributeValue[];
  status: 'open' | 'resolved';
  resolutionRule?: 'most_recent' | 'majority' | 'manual' | null;
  resolvedAtCycle?: number;
  resolvedValue?: unknown;
  createdAtCycle: number;
}

/**
 * Reality slice consumed by `runcor-substrate.RealityLayer`. The `rendered` field contains
 * pre-formatted text the substrate's Reality layer renders directly into the prompt
 * (substrate doesn't compose the text itself; the cube owns rendering).
 */
export interface RealitySlice {
  entities: Entity[];
  relevantEdges: Edge[];
  openConflicts: Conflict[];
  rendered: string;
}

/**
 * V2 ingest input. The `cycle` field is required so that every persisted Entity / Edge / Conflict
 * carries cycle-aware tracking (createdAtCycle / lastUpdatedCycle). The pipeline (identify →
 * normalize → relate → conflict → persist) reads this from `input.cycle`.
 */
export interface IngestInput {
  cycle: number;
  source: string;
  payload: string | object;
}

/** Output of `DataCube.ingest(input)` — what was created / updated / conflicted this cycle. */
export interface IngestResult {
  entity: Entity;
  edges: Edge[];
  conflicts: Conflict[];
}

/** Cube-level statistics for dashboards (FR-032). */
export interface DataCubeStats {
  entities: number;
  edges: number;
  openConflicts: number;
}

/** Structured query input for `DataCube.query({ goal, drive, relevance? })`. */
export interface RealityQueryInput {
  goal?: string;
  drive?: string;
  relevance?: 'high' | 'any';
}

// ── Data Cube Types (v0.1.x, preserved for backwards compat) ──

/** A structured entity in the data cube. Entity types are open-ended. */
export interface DataNode {
  id: string;
  entity_type: string;
  content: string;
  structured: Record<string, unknown>;
  embedding: number[];
  confidence: number;
  source: DataSource;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DataSource {
  origin: string;
  path: string;
  extracted_at: string;
  method: string;
}

/** A typed relationship between two entities. Edge types are open-ended. */
export interface DataEdge {
  from_id: string;
  to_id: string;
  type: string;
  weight: number;
  evidence: string;
  created_at: string;
}

// ── Pipeline Types ──

/** Raw content arriving for processing */
export interface RawContent {
  text: string;
  source: DataSource;
  metadata?: Record<string, unknown>;
}

/** Result of the identify stage */
export interface IdentifyResult {
  entity_type: string;
  confidence: number;
  evidence: string;
}

/** Result of the normalize stage */
export interface NormalizeResult {
  structured: Record<string, unknown>;
  canonical_name: string;
  confidence: number;
}

/** Result of the relate stage */
export interface RelateResult {
  matches: Array<{
    node_id: string;
    edge_type: string;
    weight: number;
    evidence: string;
  }>;
}

/** Result of the conflict stage */
export interface ConflictResult {
  conflicts: Array<{
    existing_node_id: string;
    field: string;
    existing_value: unknown;
    new_value: unknown;
    resolution: 'new_wins' | 'existing_wins' | 'escalate';
    reason: string;
  }>;
}

/** Full pipeline result */
export interface PipelineResult {
  node: DataNode;
  edges: DataEdge[];
  conflicts: ConflictResult;
}

// ── Query Types ──

export interface QueryOptions {
  type?: string;
  limit?: number;
  minConfidence?: number;
}

export interface GraphResult {
  nodes: DataNode[];
  edges: DataEdge[];
}

// ── Model Interface (compatible with runcor-memory's ModelComplete) ──

export interface ModelComplete {
  complete(request: {
    prompt?: string;
    systemPrompt?: string;
    responseFormat?: 'text' | 'json';
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

// ── Data Agent Config ──

export interface DataAgentConfig {
  dbPath?: string;
  openaiApiKey?: string;
  model?: ModelComplete;
  agentRole?: string;
  memoryConfig?: {
    tau?: number;
    durability?: number;
    promoteThreshold?: number;
    forgetThreshold?: number;
  };
}
