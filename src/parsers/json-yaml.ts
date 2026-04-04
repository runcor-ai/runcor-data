// JSON/YAML parser — converts structured data into RawContent

import type { RawContent, DataSource } from '../types.js';

/** Parse JSON text into RawContent items */
export function parseJson(text: string, source: DataSource): RawContent[] {
  const parsed = JSON.parse(text);

  // If it's an array, each item becomes a separate record
  if (Array.isArray(parsed)) {
    return parsed.map((item, i) => ({
      text: typeof item === 'string' ? item : JSON.stringify(item, null, 2),
      source: { ...source, method: 'json-parser', path: `${source.path}[${i}]` },
      metadata: { index: i, raw: item },
    }));
  }

  // If it's an object, it's a single record
  return [{
    text: JSON.stringify(parsed, null, 2),
    source: { ...source, method: 'json-parser' },
    metadata: { raw: parsed },
  }];
}

/** Parse YAML text into RawContent items (basic support — key: value lines) */
export function parseYaml(text: string, source: DataSource): RawContent[] {
  // Basic YAML parsing — for full support, use the yaml package
  return [{
    text,
    source: { ...source, method: 'yaml-parser' },
  }];
}
