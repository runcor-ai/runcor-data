// Tests for V2-002 RealitySlice — DataCube.queryReality returns rendered text + getEntity +
// getStats + listConflicts surface checks.
// Per autonomous-company-v2/specs/002-faithful-rebuild/tasks.md T027.
//
// Tests use the DataCube without a model — populate the underlying database directly so the
// tests don't need a real LLM (which T025/T026/T027 are meant to avoid).

import { DataCube } from '../src/data-cube.js';
import { DataDatabase } from '../src/database.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { Conflict } from '../src/types.js';

const DB_PATH = './test-reality-slice.db';
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

// Pre-populate the underlying database (skipping the LLM-driven pipeline — tests just need
// the cube's surface methods to work, not the ingest pipeline).
const db = new DataDatabase(DB_PATH);
const now = new Date().toISOString();
const e1Id = randomUUID();
const e2Id = randomUUID();

db.insertNode({
  id: e1Id,
  entity_type: 'invoice',
  content: 'Invoice #100 from Acme Corp',
  structured: { amount: 100, vendor: 'Acme Corp' },
  embedding: [],
  confidence: 0.9,
  source: { origin: 'src1', path: '/tmp/inv1.txt', extracted_at: now, method: 'parse' },
  version: 1,
  created_at: now,
  updated_at: now,
}, { cycle: 5, name: 'Invoice #100' });

db.insertNode({
  id: e2Id,
  entity_type: 'invoice',
  content: 'Invoice #200 from Acme Corp',
  structured: { amount: 250, vendor: 'Acme Corp' },
  embedding: [],
  confidence: 0.9,
  source: { origin: 'src1', path: '/tmp/inv2.txt', extracted_at: now, method: 'parse' },
  version: 1,
  created_at: now,
  updated_at: now,
}, { cycle: 5, name: 'Invoice #200' });

db.insertEdge({
  from_id: e1Id,
  to_id: e2Id,
  type: 'related_to',
  weight: 0.8,
  evidence: 'Both invoices from same vendor',
  created_at: now,
});

db.insertProvenance({ entity_id: e1Id, attribute: 'amount', value: { value: 100, source: 'src1', cycle: 5 } });
db.insertProvenance({ entity_id: e1Id, attribute: 'vendor', value: { value: 'Acme Corp', source: 'src1', cycle: 5 } });
db.insertProvenance({ entity_id: e2Id, attribute: 'amount', value: { value: 250, source: 'src1', cycle: 5 } });
db.insertProvenance({ entity_id: e2Id, attribute: 'vendor', value: { value: 'Acme Corp', source: 'src1', cycle: 5 } });

const conflict: Conflict = {
  id: randomUUID(),
  entityId: e1Id,
  attribute: 'amount',
  values: [
    { value: 100, source: 'src1', cycle: 5 },
    { value: 120, source: 'src2', cycle: 7 },
  ],
  status: 'open',
  resolutionRule: null,
  createdAtCycle: 7,
};
db.insertConflict(conflict);
db.close();

console.log('\n=== getEntity (V2 shape) ===\n');

const cube = new DataCube({ dbPath: DB_PATH });

const e1 = cube.getEntity(e1Id);
assert(e1 !== null, 'getEntity returns the entity');
assert(e1?.id === e1Id, 'Entity id roundtrips');
assert(e1?.name === 'Invoice #100', `Entity name == "Invoice #100" (got "${e1?.name}")`);
assert(e1?.type === 'invoice', 'Entity type roundtrips');
assert(e1?.createdAtCycle === 5, 'createdAtCycle == 5');
assert(e1?.lastUpdatedCycle === 5, 'lastUpdatedCycle == 5');
assert(Object.keys(e1?.attributes ?? {}).length === 2, '2 attributes (amount, vendor)');
assert(e1?.attributes.amount?.value === 100, 'amount attribute value == 100');
assert(e1?.attributes.amount?.cycle === 5, 'amount attribute cycle == 5');
assert(e1?.attributes.amount?.source === 'src1', 'amount attribute source == src1');
assert(e1?.attributes.vendor?.value === 'Acme Corp', 'vendor attribute roundtrips');
assert(Array.isArray(e1?.provenance) && e1.provenance.length >= 1, 'provenance array populated');

assert(cube.getEntity('does-not-exist') === null, 'getEntity returns null for unknown id');

console.log('\n=== getStats ===\n');

const stats = cube.getStats();
assert(stats.entities === 2, `entities count == 2 (got ${stats.entities})`);
assert(stats.edges === 1, `edges count == 1 (got ${stats.edges})`);
assert(stats.openConflicts === 1, `openConflicts count == 1 (got ${stats.openConflicts})`);

console.log('\n=== listConflicts ===\n');

const opens = cube.listConflicts('open');
assert(opens.length === 1, '1 open conflict listed');
assert(opens[0].entityId === e1Id, 'Conflict references e1');
assert(opens[0].attribute === 'amount', 'Conflict attribute is amount');
assert(opens[0].values.length === 2, '2 conflicting values');

const allConflicts = cube.listConflicts('all');
assert(allConflicts.length === 1, "all status returns 1 conflict (only 1 exists)");

console.log('\n=== queryReality (RealitySlice with rendered text) ===\n');

// Without a model configured, search() requires embeddings — would call the OpenAI key path.
// queryReality with no goal/drive falls back to "most recently updated entities" — no model needed.
const slice = await cube.queryReality({});
assert(slice.entities.length === 2, 'Slice contains both entities');
assert(slice.relevantEdges.length === 1, 'Slice contains the related_to edge');
assert(slice.openConflicts.length === 1, 'Slice contains the open conflict');
assert(typeof slice.rendered === 'string' && slice.rendered.length > 0, 'rendered is non-empty string');
assert(slice.rendered.startsWith('REALITY'), 'rendered starts with REALITY header');
assert(slice.rendered.includes('Invoice #100'), 'rendered text mentions entity name');
assert(slice.rendered.includes('Invoice #200'), 'rendered text mentions both entities');
assert(slice.rendered.includes('related_to'), 'rendered text mentions the edge relation');
assert(slice.rendered.includes('Open conflicts'), 'rendered text shows open conflicts section');
assert(slice.rendered.includes('amount'), 'rendered text shows the conflicted attribute');

// V2-shape Edge: fromEntityId / toEntityId / relation naming
const edge = slice.relevantEdges[0];
assert(edge.fromEntityId === e1Id, 'V2 Edge.fromEntityId set correctly');
assert(edge.toEntityId === e2Id, 'V2 Edge.toEntityId set correctly');
assert(edge.relation === 'related_to', 'V2 Edge.relation set correctly');
assert(typeof edge.id === 'string' && edge.id.length > 0, 'V2 Edge.id is non-empty');

console.log('\n=== queryReality with empty cube ===\n');

cube.close();
unlinkSync(DB_PATH);
try { unlinkSync(DB_PATH + '-wal'); } catch { /* */ }
try { unlinkSync(DB_PATH + '-shm'); } catch { /* */ }

const emptyCube = new DataCube({ dbPath: DB_PATH });
const emptySlice = await emptyCube.queryReality({});
assert(emptySlice.entities.length === 0, 'Empty cube → 0 entities');
assert(emptySlice.relevantEdges.length === 0, 'Empty cube → 0 edges');
assert(emptySlice.openConflicts.length === 0, 'Empty cube → 0 conflicts');
assert(emptySlice.rendered.includes('No relevant entities'), 'Empty cube → empty-state rendered text');

emptyCube.close();
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
