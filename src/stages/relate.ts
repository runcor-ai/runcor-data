// Stage 3: Relate — find connections between new entity and existing entities

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataNode, RelateResult, ModelComplete } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '..', '..', 'specs', 'resolve-entity.rpp');

let cachedSpec: string | null = null;
function loadSpec(): string {
  if (!cachedSpec) cachedSpec = readFileSync(SPEC_PATH, 'utf-8');
  return cachedSpec;
}

// Re-use runcor-memory's embedding functions
let cosineSimilarityFn: ((a: number[], b: number[]) => number) | null = null;

async function loadSimilarity(): Promise<void> {
  if (cosineSimilarityFn) return;
  const mod = await import('runcor-memory');
  cosineSimilarityFn = mod.cosineSimilarity;
}

/** Find candidate matches using embedding similarity, then use LLM for precise resolution */
export async function relate(
  newEntity: { content: string; entity_type: string; structured: Record<string, unknown>; embedding: number[] },
  existingNodes: DataNode[],
  model: ModelComplete,
): Promise<RelateResult> {
  await loadSimilarity();

  // Phase 1: Embedding-based candidate selection (code-first, cheap)
  const candidates = existingNodes
    .filter(n => n.embedding.length > 0)
    .map(node => ({
      node,
      similarity: cosineSimilarityFn!(newEntity.embedding, node.embedding),
    }))
    .filter(c => c.similarity > 0.4) // loose threshold for candidates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10); // top 10 candidates

  if (candidates.length === 0) {
    return { matches: [] };
  }

  // Phase 2: LLM-based precise resolution
  const spec = loadSpec();

  const response = await model.complete({
    systemPrompt: `You are an entity resolver. Follow this R++ specification exactly.\n\n\`\`\`rpp\n${spec}\n\`\`\``,
    prompt: JSON.stringify({
      new_entity: {
        entity_type: newEntity.entity_type,
        structured: newEntity.structured,
        content: newEntity.content.slice(0, 2000),
      },
      candidates: candidates.map(c => ({
        id: c.node.id,
        entity_type: c.node.entity_type,
        structured: c.node.structured,
        content: c.node.content.slice(0, 1000),
        similarity: c.similarity.toFixed(3),
      })),
      entity_type: newEntity.entity_type,
    }),
    responseFormat: 'json',
    temperature: 0,
    maxTokens: 1000,
  });

  const parsed = JSON.parse(response.text);
  const matches = (parsed.matches || [])
    .filter((m: { confidence?: number }) => (m.confidence ?? 0) >= 0.6)
    .slice(0, 5)
    .map((m: { candidate_id: string; edge_type?: string; confidence?: number; evidence?: string }) => ({
      node_id: String(m.candidate_id),
      edge_type: String(m.edge_type || 'related'),
      weight: Math.max(0, Math.min(1, Number(m.confidence) || 0.6)),
      evidence: String(m.evidence || ''),
    }));

  return { matches };
}
