// Test runner — invokes each test file in sequence so `npm test` runs the full suite.
// Spawns Node directly with `--import tsx` to avoid shell-quoting issues with paths
// containing spaces (Windows tsx.cmd shim breaks on `C:\runcor May 3 2026\...`).

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const testFiles = [
  'test-database.ts',
  'test-cycle-aware.ts',
  'test-conflict-persistence.ts',
  'test-reality-slice.ts',
];

let allPassed = true;

for (const file of testFiles) {
  const filePath = resolve(__dirname, file);
  if (!existsSync(filePath)) {
    console.log(`\n━━━ Skipping ${file} (not found) ━━━`);
    continue;
  }
  console.log(`\n━━━ Running ${file} ━━━`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', filePath], { stdio: 'inherit' });
  if (result.status !== 0) {
    allPassed = false;
    console.log(`\n!!! ${file} failed (exit ${result.status})`);
  }
}

console.log(allPassed ? '\n✓ All test files passed' : '\n✗ One or more test files failed');
process.exit(allPassed ? 0 : 1);
