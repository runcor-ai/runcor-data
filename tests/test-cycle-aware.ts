// Tests for V2-002 cycle-aware tracking on DataNode + provenance recording.
// Per autonomous-company-v2/specs/002-faithful-rebuild/tasks.md T025.

import { DataDatabase } from '../src/database.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

const DB_PATH = './test-cycle-aware.db';
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

console.log('\n=== Cycle-aware tracking ===\n');

// Insert with cycle-aware metadata
const nodeId = randomUUID();
const now = new Date().toISOString();
db.insertNode({
  id: nodeId,
  entity_type: 'document',
  content: 'Test document content',
  structured: { name: 'Doc 1', author: 'Alice' },
  embedding: [],
  confidence: 0.9,
  source: { origin: 'test', path: '/tmp/doc1.txt', extracted_at: now, method: 'manual' },
  version: 1,
  created_at: now,
  updated_at: now,
}, { cycle: 5, name: 'Doc 1' });

const meta = db.getNodeCycleMeta(nodeId);
assert(meta !== null, 'getNodeCycleMeta returns metadata for inserted node');
assert(meta?.createdAtCycle === 5, `createdAtCycle == 5 (got ${meta?.createdAtCycle})`);
assert(meta?.lastUpdatedCycle === 5, `lastUpdatedCycle == 5 on insert (got ${meta?.lastUpdatedCycle})`);
assert(meta?.name === 'Doc 1', `name == "Doc 1" (got ${meta?.name})`);

// Update with new cycle
db.updateNode(nodeId, { lastUpdatedCycle: 12, name: 'Doc 1 (revised)' });
const meta2 = db.getNodeCycleMeta(nodeId);
assert(meta2?.createdAtCycle === 5, 'createdAtCycle unchanged after update');
assert(meta2?.lastUpdatedCycle === 12, `lastUpdatedCycle bumps to 12 (got ${meta2?.lastUpdatedCycle})`);
assert(meta2?.name === 'Doc 1 (revised)', 'name updates correctly');

// Default cycle is -1 when not provided (legacy / pre-V2 inserts)
const legacyId = randomUUID();
db.insertNode({
  id: legacyId,
  entity_type: 'document',
  content: 'Legacy node',
  structured: {},
  embedding: [],
  confidence: 0.5,
  source: { origin: 'legacy', path: '', extracted_at: now, method: 'unknown' },
  version: 1,
  created_at: now,
  updated_at: now,
}); // no opts.cycle
const legacyMeta = db.getNodeCycleMeta(legacyId);
assert(legacyMeta?.createdAtCycle === -1, 'Legacy insert defaults createdAtCycle to -1');
assert(legacyMeta?.lastUpdatedCycle === -1, 'Legacy insert defaults lastUpdatedCycle to -1');
assert(legacyMeta?.name === '', 'Legacy insert defaults name to empty string');

console.log('\n=== Provenance recording ===\n');

// Per-attribute provenance
const entId = randomUUID();
db.insertNode({
  id: entId,
  entity_type: 'invoice',
  content: 'Invoice #100',
  structured: {},
  embedding: [],
  confidence: 0.9,
  source: { origin: 'src1', path: '', extracted_at: now, method: 'parse' },
  version: 1,
  created_at: now,
  updated_at: now,
}, { cycle: 1, name: 'Invoice #100' });

db.insertProvenance({
  entity_id: entId,
  attribute: 'amount',
  value: { value: 100, source: 'src1', cycle: 1 },
});
db.insertProvenance({
  entity_id: entId,
  attribute: 'amount',
  value: { value: 150, source: 'src2', cycle: 5 },
});
db.insertProvenance({
  entity_id: entId,
  attribute: 'vendor',
  value: { value: 'Acme', source: 'src1', cycle: 1 },
});

const latest = db.getLatestAttributesForEntity(entId);
assert(Object.keys(latest).length === 2, '2 distinct attributes: amount + vendor');
assert(latest.amount?.value === 150, 'Latest amount is from cycle 5 (highest cycle wins)');
assert(latest.amount?.cycle === 5, 'Latest amount cycle == 5');
assert(latest.vendor?.value === 'Acme', 'Vendor unchanged');

const amountHistory = db.getProvenanceHistory(entId, 'amount');
assert(amountHistory.length === 2, '2 historical values for amount');
assert(amountHistory[0].cycle === 1, 'First historical entry is cycle 1');
assert(amountHistory[1].cycle === 5, 'Second historical entry is cycle 5 (chronological asc)');

// Provenance for an entity with no rows returns empty record
const orphanId = randomUUID();
db.insertNode({
  id: orphanId,
  entity_type: 'document',
  content: '',
  structured: {},
  embedding: [],
  confidence: 0.5,
  source: { origin: '', path: '', extracted_at: now, method: '' },
  version: 1,
  created_at: now,
  updated_at: now,
});
const orphanLatest = db.getLatestAttributesForEntity(orphanId);
assert(Object.keys(orphanLatest).length === 0, 'Empty provenance returns empty object');

db.close();
cleanup();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
