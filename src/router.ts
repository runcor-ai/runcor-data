// File type router — dispatches raw files to appropriate parsers

import type { RawContent, DataSource } from './types.js';
import { parseCsv } from './parsers/csv.js';
import { parseJson, parseYaml } from './parsers/json-yaml.js';

/** Route a file to the appropriate parser based on extension */
export function routeFile(text: string, source: DataSource): RawContent[] {
  const ext = getExtension(source.path);

  switch (ext) {
    case 'csv':
    case 'tsv':
      return parseCsv(text, source);

    case 'json':
      return parseJson(text, source);

    case 'yaml':
    case 'yml':
      return parseYaml(text, source);

    default:
      // For unrecognized types or pre-extracted text (from MCP), pass through as-is
      return [{
        text,
        source: { ...source, method: 'passthrough' },
      }];
  }
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return '';
  return path.slice(dot + 1).toLowerCase();
}
