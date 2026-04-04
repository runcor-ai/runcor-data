// Stage 2: Normalize — extract structured fields from raw text

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawContent, NormalizeResult, ModelComplete } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '..', '..', 'specs', 'normalize-entity.rpp');

let cachedSpec: string | null = null;
function loadSpec(): string {
  if (!cachedSpec) cachedSpec = readFileSync(SPEC_PATH, 'utf-8');
  return cachedSpec;
}

export async function normalize(
  content: RawContent,
  entityType: string,
  model: ModelComplete,
  learnedFields: string[],
  agentMemory: string,
): Promise<NormalizeResult> {
  const spec = loadSpec();

  const response = await model.complete({
    systemPrompt: `You are a data normalizer. Follow this R++ specification exactly.\n\n\`\`\`rpp\n${spec}\n\`\`\``,
    prompt: JSON.stringify({
      raw_text: content.text.slice(0, 4000),
      entity_type: entityType,
      learned_fields: learnedFields,
      agent_memory: agentMemory,
    }),
    responseFormat: 'json',
    temperature: 0,
    maxTokens: 1000,
  });

  const parsed = JSON.parse(response.text);

  return {
    structured: parsed.structured || {},
    canonical_name: String(parsed.canonical_name || entityType),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
  };
}
