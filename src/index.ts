// runcor-data — public API

export { DataCube } from './data-cube.js';
export { DataDatabase } from './database.js';
export { createDataAgent } from './data-agent.js';
export type { DataAgent } from './data-agent.js';
export { runPipeline } from './pipeline.js';
export type { PipelineOptions } from './pipeline.js';
export { routeFile } from './router.js';

// Pipeline stages (for advanced usage)
export { identify } from './stages/identify.js';
export { normalize } from './stages/normalize.js';
export { relate } from './stages/relate.js';
export { detectConflicts } from './stages/conflict.js';
export { persist } from './stages/persist.js';

// Parsers
export { parseCsv } from './parsers/csv.js';
export { parseJson, parseYaml } from './parsers/json-yaml.js';

// Types
export type {
  DataNode,
  DataEdge,
  DataSource,
  RawContent,
  IdentifyResult,
  NormalizeResult,
  RelateResult,
  ConflictResult,
  PipelineResult,
  QueryOptions,
  GraphResult,
  ModelComplete,
  DataAgentConfig,
} from './types.js';
