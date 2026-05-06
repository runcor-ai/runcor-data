// Tests for V2-002 persisted Conflict entity (FR-082).
// Per autonomous-company-v2/specs/002-faithful-rebuild/tasks.md T026.

import { DataDatabase } from '../src/database.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { Conflict } from '../src/types.js';

const DB_PATH = './test-conflict-persistence.db';
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function cleanup(): void {
  try { unlinkSync(DB_PATH); } catch { /* ignore */ }
  try { unlinkSync(DB_PATH + '-wal'); } catch { /* ignore */ }
  try { unlinkSync(DB_PATH + '-shm'); } catch { /* ignore */ }
}

cleanup();
const db = new DataDatabase(DB_PATH);

console.log('\n=== Conflict persistence ===\n');

// Set up an entity that will own the conflicts
const entityId = randomUUID();
const now = new Date().toISOString();
db.insertNode({
  id: entityId,
  entity_type: 'invoice',
  content: 'Invoice #100',
  structured: { amount: 100 },
  embedding: [],
  confidence: 0.9,
  source: { origin: 'src1', path: '', extracted_at: now, method: 'parse' },
  version: 1,
  created_at: now,
  updated_at: now,
}, { cycle: 1, name: 'Invoice #100' });

// Insert open conflict
const c1: Conflict = {
  id: randomUUID(),
  entityId,
  attribute: 'amount',
  values: [
    { value: 100, source: 'src1', cycle: 1 },
    { value: 150, source: 'src2', cycle: 5 },
  ],
  status: 'open',
  resolutionRule: null,
  createdAtCycle: 5,
};
db.insertConflict(c1);

const fetched = db.getConflict(c1.id);
assert(fetched !== null, 'Inserted conflict is retrievable by id');
assert(fetched?.entityId === entityId, 'entityId roundtrips');
assert(fetched?.attribute === 'amount', 'attribute roundtrips');
assert(fetched?.values.length === 2, '2 conflicting values stored');
assert(fetched?.values[0].cycle === 1, 'First value cycle roundtrips');
assert(fetched?.values[1].value === 150, 'Second value roundtrips');
assert(fetched?.status === 'open', 'Status defaults to open');
assert(fetched?.resolutionRule === null, 'resolutionRule null on open');
assert(fetched?.resolvedAtCycle === undefined, 'resolvedAtCycle undefined on open');
assert(fetched?.createdAtCycle === 5, 'createdAtCycle roundtrips');

// Insert another conflict
const c2: Conflict = {
  id: randomUUID(),
  entityId,
  attribute: 'vendor',
  values: [
    { value: 'Acme', source: 'src1', cycle: 1 },
    { value: 'Acme Corp.', source: 'src2', cycle: 5 },
  ],
  status: 'open',
  resolutionRule: null,
  createdAtCycle: 5,
};
db.insertConflict(c2);

// listConflicts default: open only
const opens = db.getConflicts('open');
assert(opens.length === 2, '2 open conflicts after 2 inserts');
const allBefore = db.getConflicts();
assert(allBefore.length === 2, '2 conflicts total when no status filter');

// Resolve one
db.resolveConflict(c1.id, 'most_recent', 150, 7);
const c1After = db.getConflict(c1.id);
assert(c1After?.status === 'resolved', 'Status flipped to resolved');
assert(c1After?.resolutionRule === 'most_recent', 'resolutionRule recorded');
assert(c1After?.resolvedAtCycle === 7, 'resolvedAtCycle recorded');
assert(c1After?.resolvedValue === 150, 'resolvedValue stored');

const opensAfter = db.getConflicts('open');
assert(opensAfter.length === 1, 'Only 1 open conflict remains after resolution');
const resolvedOnly = db.getConflicts('resolved');
assert(resolvedOnly.length === 1, '1 resolved conflict');
assert(resolvedOnly[0].id === c1.id, 'resolved-filter returns the resolved conflict');

// Counts
assert(db.countOpenConflicts() === 1, 'countOpenConflicts() == 1');

// resolveConflict on already-resolved is idempotent (just updates the resolution_rule).
db.resolveConflict(c1.id, 'manual', 200, 10);
const c1After2 = db.getConflict(c1.id);
assert(c1After2?.resolutionRule === 'manual', 'Resolving again updates the rule');
assert(c1After2?.resolvedValue === 200, 'Resolving again updates the value');

db.close();
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
