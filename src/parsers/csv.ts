// CSV parser — converts CSV text into individual row records

import type { RawContent, DataSource } from '../types.js';

/** Parse CSV text into individual records, one RawContent per row */
export function parseCsv(text: string, source: DataSource): RawContent[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return []; // need header + at least one row

  const headers = splitCsvLine(lines[0]);
  const results: RawContent[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const rowObj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      rowObj[headers[j]] = values[j] ?? '';
    }

    results.push({
      text: headers.map((h, j) => `${h}: ${values[j] ?? ''}`).join('\n'),
      source: { ...source, method: 'csv-parser', path: `${source.path}:row${i}` },
      metadata: { row_number: i, row_data: rowObj },
    });
  }

  return results;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
