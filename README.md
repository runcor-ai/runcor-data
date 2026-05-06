# runcor-data

Data agent and data cube for the [runcor](https://github.com/runcor-ai/runcor) AI runtime. Takes unstructured data and adds structure so it's meaningful to the system.

> **v0.2.0 — V2-002 shape alignment.** Adds the V2-shape surface alongside the existing v0.1.x primitives: `Entity` (with `name`, per-attribute `attributes`, `provenance`, cycle-aware tracking), `Edge` (V2 naming: `fromEntityId`/`toEntityId`/`relation`), persisted `Conflict` (FR-082), `RealitySlice` (with pre-rendered text for substrate's RealityLayer), and `DataCube.ingest(input: IngestInput)` for cycle-aware ingestion. Schema migrates idempotently — existing v0.1.x rows continue to work, with cycle metadata defaulting to `-1` until updated. See [V2-002 surface](#v2-002-surface) below.

## What it does

runcor-data is a full cognitive agent that ingests unstructured content (emails, PDFs, API responses, CSV files — anything) and turns it into structured, queryable knowledge in a graph database called the data cube.

```
raw content → [Identify] → [Normalize] → [Relate] → [Conflict] → [Persist] → data cube
                  ↕               ↕            ↕           ↕
              agent memory    agent memory  agent memory  agent memory
```

The agent gets better over time. Its own memory cubes (via [runcor-memory](https://github.com/runcor-ai/runcor-memory)) learn extraction patterns, source reliability, and field conventions. The data cube stores the structured facts. Memory teaches *how* to extract. The data cube stores *what* was extracted.

## 3-cube architecture

1. **Short-term memory** — recent operational learnings: "this source has trailing whitespace", "that column labeled 'date' is actually Unix timestamps"
2. **Long-term memory** — proven patterns that survived decay: "Source A is authoritative for amounts", "invoices from SPO lead OneDrive copies by 2 days"
3. **Data cube** — structured external facts. Non-decaying, versioned, conflict-aware. Entities and edges.

## The pipeline

Five stages, each code-first with LLM fallback via [R++](https://github.com/runcor-ai/rpp) specs:

| Stage | What it does | R++ spec |
|-------|-------------|----------|
| **Identify** | Classifies what the content is — semantic type, not file type. Open-ended. | `classify-entity.rpp` |
| **Normalize** | Extracts structured fields. Dynamic per type — learned, not predefined. | `normalize-entity.rpp` |
| **Relate** | Finds connections to existing entities via embeddings + LLM resolution. | `resolve-entity.rpp` |
| **Conflict** | Detects field-level contradictions. Resolves or escalates. | `resolve-conflict.rpp` |
| **Persist** | Writes entity + edges to the data cube with embeddings. | — |

Entity types are **open-ended** — `entity_type` is a string, not an enum. The agent names what it finds: "invoice", "sensor_reading", "shipping_manifest", anything.

## Bolt-on integration

runcor-data is a bolt-on component. The runcor engine is the dependency.

```typescript
import { createEngine } from 'runcor';
import { DataCube, createDataAgent } from 'runcor-data';

const engine = await createEngine({ ... });
const dataCube = new DataCube({ dbPath: './data.db', openaiApiKey: process.env.OPENAI_API_KEY });
const agent = createDataAgent(dataCube, ctx.model, { openaiApiKey: process.env.OPENAI_API_KEY });

// Ingest content
const result = await agent.ingest({
  text: 'Invoice #4821\nVendor: Marketplace Corp\nAmount: $4,200\nDue: 2025-03-15',
  source: { origin: 'email', path: 'inbox/msg-42', extracted_at: new Date().toISOString(), method: 'mcp' },
});

// Query the data cube
const nodes = await dataCube.search('Marketplace Corp invoices');
const related = dataCube.getRelated(nodes[0].id, 2);
```

## The data cube

SQLite graph database with two tables: `data_nodes` (entities) and `data_edges` (relationships).

### Query API

```typescript
dataCube.search(query, options?)        // Semantic search via embeddings
dataCube.getById(id)                    // Single node
dataCube.getByType(type)                // All nodes of a type
dataCube.getEdges(nodeId, type?)        // Edges for a node
dataCube.getRelated(nodeId, depth?)     // Graph traversal
dataCube.getConflicts()                 // Unresolved contradictions
dataCube.query(naturalLanguage)         // NL query → nodes + edges
```

### Write API

```typescript
dataCube.persist(node)                  // Add entity (auto-embeds)
dataCube.addEdge(edge)                  // Add relationship
dataCube.update(id, updates)            // Update entity (increments version)
```

## V2-002 surface

The v0.2.0 release adds a parallel V2-shape surface for callers consuming runcor-data via the substrate's RealityLayer pipeline. Existing v0.1.x methods (`search`, `getById`, `query(naturalLanguage)`, `persist`, `addEdge`, `update`, `getConflicts`) are preserved unchanged.

### V2 types

```typescript
interface Entity {
  id: string;
  name: string;                                      // derived from structured.name|title or content
  type: string;
  attributes: Record<string, AttributeValue>;        // per-attribute provenance
  provenance: ProvenanceRecord[];
  createdAtCycle: number;                            // V2 cycle counter (-1 for legacy rows)
  lastUpdatedCycle: number;
}

interface AttributeValue { value: unknown; source: string; cycle: number }

interface Edge {
  id: string;
  fromEntityId: string;                              // V2 naming (vs v0.1.x's from_id)
  toEntityId: string;
  relation: string;                                  // V2 naming (vs v0.1.x's type)
  attributes?: Record<string, AttributeValue>;
  provenance: ProvenanceRecord[];
}

interface Conflict {                                 // PERSISTED (vs transient ConflictResult)
  id: string;
  entityId: string;
  attribute: string;
  values: AttributeValue[];                          // ≥2 contradictory values w/ provenance
  status: 'open' | 'resolved';
  resolutionRule?: 'most_recent' | 'majority' | 'manual' | null;
  resolvedAtCycle?: number;
  resolvedValue?: unknown;
  createdAtCycle: number;
}

interface RealitySlice {
  entities: Entity[];
  relevantEdges: Edge[];
  openConflicts: Conflict[];
  rendered: string;                                  // pre-rendered text for substrate RealityLayer
}
```

### V2 API on DataCube

```typescript
cube.getEntity(id)                                  // V2-shape Entity (alias for getById)
cube.getStats()                                     // { entities, edges, openConflicts }
cube.listConflicts(status?)                         // 'open' (default) | 'resolved' | 'all'
cube.queryReality({ goal?, drive?, relevance? })    // Promise<RealitySlice>
cube.ingest({ cycle, source, payload })             // Promise<IngestResult> — cycle-aware ingest
cube.resolveConflict(id, rule, resolvedValue, cycle)
```

### Schema migration

The v0.2.0 migration is idempotent and backwards-compatible:
- Adds `created_at_cycle` (default -1) + `last_updated_cycle` (default -1) + `name` (default '') columns to `data_nodes` via `ALTER TABLE ADD COLUMN`. Existing rows continue to work; `getEntity` synthesizes attributes from `structured` with cycle=-1 sentinel for pre-V2 data.
- Creates new `provenance` table for per-attribute provenance (entity_id, attribute, value_json, source, cycle, recorded_at).
- Creates new `conflicts` table for persisted Conflict rows (id, entity_id, attribute, values_json, status, resolution_rule, resolved_at_cycle, resolved_value_json, created_at_cycle, created_at).

### Conflict pipeline (FR-082)

`DataCube.ingest({ cycle, source, payload })` runs the existing 5-stage pipeline (identify → normalize → relate → conflict → persist), then:
1. Records per-attribute provenance for every structured field on the new/updated entity.
2. Writes any field-level conflicts the existing `detectConflicts` stage produces as persisted `Conflict` rows. Conflicts with resolution `escalate` → status `'open'`; `new_wins`/`existing_wins` → status `'resolved'` with `resolutionRule='most_recent'` and `resolvedValue` set.
3. Stamps cycle-aware metadata (`created_at_cycle` / `last_updated_cycle` / derived `name`) on the entity.

The legacy `ConflictResult` (transient per-ingest output) is still produced by the pipeline and unchanged.

## Setup

```bash
npm install runcor-data
```

Requires:
- Node.js >= 20.6.0
- `OPENAI_API_KEY` for embeddings (uses text-embedding-3-small via runcor-memory)

## Dependencies

- [runcor](https://github.com/runcor-ai/runcor) (peer) — the AI runtime engine
- [runcor-memory](https://github.com/runcor-ai/runcor-memory) — cognitive memory + embeddings
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — data cube storage

## Testing

```bash
npm test                          # Full suite: 110 tests across 4 files (no API key needed)
npm run test:database             # 31 tests — schema CRUD + insert/update/delete
npm run test:cycle-aware          # 18 tests — V2-002 cycle-aware columns + provenance recording
npm run test:conflict-persistence # 22 tests — V2-002 persisted Conflict CRUD + resolution
npm run test:reality-slice        # 39 tests — V2-002 getEntity/getStats/listConflicts/queryReality
npm run test:cube                 # Data cube with embeddings (needs OPENAI_API_KEY)
npm run test:pipeline             # Full pipeline (needs OPENAI_API_KEY)
```

## File structure

```
src/
  types.ts              — DataNode, DataEdge, pipeline types
  database.ts           — SQLite schema + CRUD
  data-cube.ts          — Query and write API
  pipeline.ts           — 5-stage orchestrator
  data-agent.ts         — Full agent with 3-cube architecture
  router.ts             — File type dispatch
  stages/
    identify.ts         — Entity classification (open-ended)
    normalize.ts        — Field extraction (dynamic per type)
    relate.ts           — Entity resolution (embeddings + LLM)
    conflict.ts         — Contradiction detection + resolution
    persist.ts          — Write to data cube
  parsers/
    csv.ts              — CSV/TSV parser
    json-yaml.ts        — JSON/YAML parser
specs/
  classify-entity.rpp   — R++ spec for entity classification
  normalize-entity.rpp  — R++ spec for field extraction
  resolve-entity.rpp    — R++ spec for entity resolution
  resolve-conflict.rpp  — R++ spec for conflict resolution
```

## License

MIT
