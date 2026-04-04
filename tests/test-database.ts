// Database tests — no API key needed, no LLM calls

import { DataDatabase } from '../src/database.js';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';

const DB_PATH = './test-data.db';
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

// ── Tests ──

console.log('\n=== DataDatabase Tests ===\n');

cleanup();
const db = new DataDatabase(DB_PATH);

// Test: Insert and retrieve a node
console.log('Node CRUD:');
const nodeId = randomUUID();
const now = new Date().toISOString();

db.insertNode({
  id: nodeId,
  entity_type: 'invoice',
  content: 'Invoice #4821 from Marketplace Corp for $4,200',
  structured: { invoice_number: '4821', vendor: 'Marketplace Corp', amount: 4200 },
  embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
  confidence: 0.92,
  source: { origin: 'email', path: 'inbox/msg-42', extracted_at: now, method: 'mcp' },
  version: 1,
  created_at: now,
  updated_at: now,
});

const retrieved = db.getNode(nodeId);
assert(retrieved !== null, 'Node retrieved after insert');
assert(retrieved!.entity_type === 'invoice', 'Entity type preserved');
assert(retrieved!.structured.invoice_number === '4821', 'Structured fields preserved');
assert(retrieved!.confidence === 0.92, 'Confidence preserved');
assert(retrieved!.embedding.length === 5, 'Embedding deserialized');
assert(Math.abs(retrieved!.embedding[0] - 0.1) < 0.0001, 'Embedding values correct');
assert(retrieved!.source.origin === 'email', 'Source preserved');

// Test: Update node
db.updateNode(nodeId, { confidence: 0.95, version: 2, updated_at: new Date().toISOString() });
const updated = db.getNode(nodeId);
assert(updated!.confidence === 0.95, 'Confidence updated');
assert(updated!.version === 2, 'Version incremented');

// Test: Get by type
const byType = db.getNodesByType('invoice');
assert(byType.length === 1, 'getNodesByType returns correct count');
assert(byType[0].id === nodeId, 'getNodesByType returns correct node');

// Test: Get all nodes
const all = db.getAllNodes();
assert(all.length === 1, 'getAllNodes returns correct count');

// Test: Node count
assert(db.getNodeCount() === 1, 'getNodeCount returns 1');

// Test: Entity types
const types = db.getEntityTypes();
assert(types.includes('invoice'), 'getEntityTypes includes invoice');

// Insert a second node of different type
const node2Id = randomUUID();
db.insertNode({
  id: node2Id,
  entity_type: 'email',
  content: 'Email from sarah@marketplace.com about payment',
  structured: { from: 'sarah@marketplace.com', subject: 'Payment update' },
  embedding: [0.5, 0.4, 0.3, 0.2, 0.1],
  confidence: 0.85,
  source: { origin: 'gmail', path: 'inbox/msg-43', extracted_at: now, method: 'mcp' },
  version: 1,
  created_at: now,
  updated_at: now,
});

assert(db.getNodeCount() === 2, 'Two nodes after second insert');
assert(db.getEntityTypes().length === 2, 'Two entity types');

// Test: Edge operations
console.log('\nEdge CRUD:');

db.insertEdge({
  from_id: nodeId,
  to_id: node2Id,
  type: 'references',
  weight: 0.85,
  evidence: 'Email mentions invoice #4821',
  created_at: now,
});

const edgesFrom = db.getEdgesFrom(nodeId);
assert(edgesFrom.length === 1, 'Edge found from node');
assert(edgesFrom[0].type === 'references', 'Edge type correct');
assert(edgesFrom[0].weight === 0.85, 'Edge weight correct');

const edgesTo = db.getEdgesTo(node2Id);
assert(edgesTo.length === 1, 'Edge found to node');

const allEdges = db.getEdgesFor(nodeId);
assert(allEdges.length === 1, 'getEdgesFor returns edge');

// Test: Edge type filter
const filtered = db.getEdgesFor(nodeId, 'references');
assert(filtered.length === 1, 'Edge type filter works');
const noMatch = db.getEdgesFor(nodeId, 'conflicts');
assert(noMatch.length === 0, 'Edge type filter excludes non-matching');

// Test: Conflict edges
db.insertEdge({
  from_id: nodeId,
  to_id: node2Id,
  type: 'conflicts',
  weight: 0.5,
  evidence: 'Amount mismatch: $4,200 vs $4,500',
  created_at: now,
});

const conflicts = db.getConflictEdges();
assert(conflicts.length === 1, 'getConflictEdges finds conflict');
assert(conflicts[0].type === 'conflicts', 'Conflict edge type correct');

// Test: Delete node (cascade edges)
console.log('\nDelete:');
db.deleteNode(node2Id);
assert(db.getNode(node2Id) === null, 'Node deleted');
assert(db.getNodeCount() === 1, 'Count decreased');
assert(db.getEdgesFor(nodeId).length === 0, 'Edges cascaded on delete');

// Test: Last updated
const lastUpdated = db.getLastUpdated();
assert(lastUpdated !== null, 'getLastUpdated returns value');

// Test: Node with null embedding
console.log('\nEdge cases:');
const node3Id = randomUUID();
db.insertNode({
  id: node3Id,
  entity_type: 'document',
  content: 'A document without embedding',
  structured: {},
  embedding: [],
  confidence: 0.3,
  source: { origin: 'file', path: 'docs/readme.md', extracted_at: now, method: 'passthrough' },
  version: 1,
  created_at: now,
  updated_at: now,
});
const node3 = db.getNode(node3Id);
assert(node3 !== null, 'Node without embedding stored');
assert(node3!.embedding.length === 0, 'Empty embedding preserved');

// Cleanup
db.close();
cleanup();

// ── Summary ──
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
