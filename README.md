# runcor-data

Data agent and data cube for the [runcor](https://github.com/runcor-ai/runcor) AI runtime. Takes unstructured data and adds structure so it's meaningful to the system.

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
npm test                  # Database tests (no API key needed)
npm run test:cube         # Data cube with embeddings (needs OPENAI_API_KEY)
npm run test:pipeline     # Full pipeline (needs OPENAI_API_KEY)
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
