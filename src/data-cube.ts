// DataCube — the query and write API for the data cube

import { randomUUID } from 'node:crypto';
import { DataDatabase } from './database.js';
import type { DataNode, DataEdge, QueryOptions, GraphResult, ModelComplete } from './types.js';

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
