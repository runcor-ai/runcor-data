// Pipeline — orchestrates the 5 stages: Identify → Normalize → Relate → Conflict → Persist

import type { DataCube } from './data-cube.js';
import type { RawContent, PipelineResult, ModelComplete } from './types.js';
import { identify } from './stages/identify.js';
import { normalize } from './stages/normalize.js';
import { relate } from './stages/relate.js';
import { detectConflicts } from './stages/conflict.js';
import { persist } from './stages/persist.js';

export interface PipelineOptions {
  dataCube: DataCube;
  model: ModelComplete;
  openaiApiKey?: string;
  agentMemory?: string;
  trustMemory?: string;
}

/** Run raw content through the full 5-stage pipeline */
export async function runPipeline(
  content: RawContent,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { dataCube, model, agentMemory = '', trustMemory = '' } = options;

  // Stage 1: Identify — what is this thing?
  const knownTypes = dataCube.getEntityTypes();
  const identified = await identify(content, model, knownTypes);

  // Stage 2: Normalize — extract structured fields
  // Gather learned fields for this entity type from existing nodes
  const existingOfType = dataCube.getByType(identified.entity_type);
  const learnedFields = getLearnedFields(existingOfType);
  const normalized = await normalize(content, identified.entity_type, model, learnedFields, agentMemory);

  // Stage 3: Relate — find connections to existing entities
  // We need an embedding for the new entity to do similarity search
  const { embed } = await import('runcor-memory');
  const embedding = await embed(content.text, options.openaiApiKey);

  const allNodes = existingOfType.length > 0 ? existingOfType : [];
  const related = await relate(
    {
      content: content.text,
      entity_type: identified.entity_type,
      structured: normalized.structured,
      embedding,
    },
    allNodes,
    model,
  );

  // Stage 4: Conflict — check for contradictions with matched entities
  const matchedNodes = related.matches
    .map(m => dataCube.getById(m.node_id))
    .filter((n): n is NonNullable<typeof n> => n !== null);

  const conflicts = await detectConflicts(
    normalized.structured,
    matchedNodes,
    identified.entity_type,
    content.source,
    model,
    trustMemory,
  );

  // Stage 5: Persist — write to the data cube
  const { node, edges } = await persist(
    {
      entity_type: identified.entity_type,
      content: content.text,
      structured: normalized.structured,
      confidence: Math.min(identified.confidence, normalized.confidence),
      source: content.source,
      relateResult: related,
      conflictResult: conflicts,
    },
    dataCube,
  );

  return { node, edges, conflicts };
}

/** Extract the set of field names used across existing entities of the same type */
function getLearnedFields(existingNodes: Array<{ structured: Record<string, unknown> }>): string[] {
  const fieldCounts = new Map<string, number>();
  for (const node of existingNodes) {
    for (const key of Object.keys(node.structured)) {
      fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
    }
  }
  // Return fields that appear in at least 2 entities, sorted by frequency
  return Array.from(fieldCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([field]) => field);
}
