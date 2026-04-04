// Stage 1: Identify — classify entity type from raw text

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawContent, IdentifyResult, ModelComplete } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '..', '..', 'specs', 'classify-entity.rpp');

let cachedSpec: string | null = null;
function loadSpec(): string {
  if (!cachedSpec) cachedSpec = readFileSync(SPEC_PATH, 'utf-8');
  return cachedSpec;
}

export async function identify(
  content: RawContent,
  model: ModelComplete,
  knownTypes: string[],
): Promise<IdentifyResult> {
  const spec = loadSpec();

  const response = await model.complete({
    systemPrompt: `You are an entity classifier. Follow this R++ specification exactly.\n\n\`\`\`rpp\n${spec}\n\`\`\``,
    prompt: JSON.stringify({
      raw_text: content.text.slice(0, 4000), // limit for token budget
      source_type: content.source.origin,
      filename: content.source.path,
      known_types: knownTypes,
    }),
    responseFormat: 'json',
    temperature: 0,
    maxTokens: 300,
  });

  const parsed = JSON.parse(response.text);

  return {
    entity_type: String(parsed.entity_type || 'unknown').toLowerCase().replace(/\s+/g, '_'),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
    evidence: String(parsed.evidence || ''),
  };
}
