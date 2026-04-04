// Stage 4: Conflict — detect and resolve contradictions

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataNode, ConflictResult, ModelComplete } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '..', '..', 'specs', 'resolve-conflict.rpp');

let cachedSpec: string | null = null;
function loadSpec(): string {
  if (!cachedSpec) cachedSpec = readFileSync(SPEC_PATH, 'utf-8');
  return cachedSpec;
}

/** Detect field-level conflicts between new entity and matched existing entities */
export async function detectConflicts(
  newStructured: Record<string, unknown>,
  matchedNodes: DataNode[],
  entityType: string,
  newSource: { origin: string; path: string; extracted_at: string; method: string },
  model: ModelComplete,
  trustMemory: string,
): Promise<ConflictResult> {
  const conflicts: ConflictResult['conflicts'] = [];

  for (const existing of matchedNodes) {
    // Phase 1: Code-first — find fields that exist in both and differ
    const fieldConflicts = findFieldConflicts(newStructured, existing.structured);

    if (fieldConflicts.length === 0) continue;

    // Phase 2: LLM resolves ambiguous conflicts
    for (const fc of fieldConflicts) {
      const resolution = await resolveConflict(
        fc.field,
        fc.newValue,
        fc.existingValue,
        newSource,
        existing.source,
        entityType,
        model,
        trustMemory,
      );

      conflicts.push({
        existing_node_id: existing.id,
        field: fc.field,
        existing_value: fc.existingValue,
        new_value: fc.newValue,
        resolution: resolution.resolution,
        reason: resolution.reasoning,
      });
    }
  }

  return { conflicts };
}

/** Code-first field comparison — no LLM needed */
function findFieldConflicts(
  newFields: Record<string, unknown>,
  existingFields: Record<string, unknown>,
): Array<{ field: string; newValue: unknown; existingValue: unknown }> {
  const conflicts: Array<{ field: string; newValue: unknown; existingValue: unknown }> = [];

  for (const [key, newVal] of Object.entries(newFields)) {
    const existingVal = existingFields[key];
    if (existingVal === undefined || existingVal === null) continue;

    // Normalize for comparison
    const normNew = normalizeForComparison(newVal);
    const normExisting = normalizeForComparison(existingVal);

    if (normNew !== normExisting) {
      conflicts.push({ field: key, newValue: newVal, existingValue: existingVal });
    }
  }

  return conflicts;
}

/** Normalize values for comparison — handles format differences */
function normalizeForComparison(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // Strip currency formatting
    const stripped = value.replace(/[$,£€]/g, '').trim().toLowerCase();
    // Try to parse as number
    const num = Number(stripped);
    if (!isNaN(num) && stripped !== '') return String(num);
    return stripped;
  }
  return JSON.stringify(value);
}

async function resolveConflict(
  fieldName: string,
  newValue: unknown,
  existingValue: unknown,
  newSource: { origin: string; path: string; extracted_at: string; method: string },
  existingSource: { origin: string; path: string; extracted_at: string; method: string },
  entityType: string,
  model: ModelComplete,
  trustMemory: string,
): Promise<{ resolution: 'new_wins' | 'existing_wins' | 'escalate'; reasoning: string }> {
  const spec = loadSpec();

  const response = await model.complete({
    systemPrompt: `You are a conflict resolver. Follow this R++ specification exactly.\n\n\`\`\`rpp\n${spec}\n\`\`\``,
    prompt: JSON.stringify({
      field_name: fieldName,
      new_value: newValue,
      existing_value: existingValue,
      new_source: newSource,
      existing_source: existingSource,
      entity_type: entityType,
      trust_memory: trustMemory,
    }),
    responseFormat: 'json',
    temperature: 0,
    maxTokens: 500,
  });

  const parsed = JSON.parse(response.text);
  const resolution = parsed.resolution === 'new_wins' ? 'new_wins'
    : parsed.resolution === 'existing_wins' ? 'existing_wins'
    : 'escalate';

  return {
    resolution,
    reasoning: String(parsed.reasoning || ''),
  };
}
