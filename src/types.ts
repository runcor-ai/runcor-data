// runcor-data types — Data Agent and Data Cube

// ── Data Cube Types ──

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
