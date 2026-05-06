// Data Agent — full cognitive agent with 3-cube architecture

import type { CognitiveMemoryAccessor } from 'runcor-memory';
import type { DataCube } from './data-cube.js';
import type { RawContent, DataAgentConfig, ModelComplete, PipelineResult } from './types.js';
import { runPipeline } from './pipeline.js';
import { routeFile } from './router.js';

export interface DataAgent {
  /** Process raw content through the pipeline */
  ingest(content: RawContent): Promise<PipelineResult>;

  /** Process a raw file (routes to parser first) */
  ingestFile(text: string, filePath: string, origin: string): Promise<PipelineResult[]>;

  /** Run a maintenance cycle (memory decay/reinforce/promote) */
  cycle(): Promise<void>;

  /** Get the data cube instance */
  getDataCube(): DataCube;
}

/** Create a data agent with its own memory cubes and data cube */
export function createDataAgent(
  dataCube: DataCube,
  model: ModelComplete,
  config?: DataAgentConfig,
): DataAgent {
  let cognitiveMemory: CognitiveMemoryAccessor | null = null;
  let currentCycle = 0;

  async function initMemory(): Promise<CognitiveMemoryAccessor> {
    if (cognitiveMemory) return cognitiveMemory;
    const { createCognitiveMemory } = await import('runcor-memory');
    const mem = createCognitiveMemory({
      dbPath: config?.dbPath ? config.dbPath.replace('.db', '-memory.db') : './data-agent-memory.db',
      openaiApiKey: config?.openaiApiKey,
      model,
      agentRole: config?.agentRole ?? 'Data agent that structures unstructured data into a queryable knowledge graph',
      config: {
        tau: config?.memoryConfig?.tau ?? 30,
        durability: config?.memoryConfig?.durability ?? 5,
        promoteThreshold: config?.memoryConfig?.promoteThreshold ?? 0.6,
        forgetThreshold: config?.memoryConfig?.forgetThreshold ?? 0.05,
      },
    });
    cognitiveMemory = mem.standalone();
    return cognitiveMemory;
  }

  async function getAgentMemory(): Promise<string> {
    const memory = await initMemory();
    const relevant = await memory.query('extraction patterns and data source learnings');
    return relevant.map((r: { node: { content: string } }) => r.node.content).join('\n');
  }

  async function getTrustMemory(): Promise<string> {
    const memory = await initMemory();
    const relevant = await memory.query('source trust and data reliability');
    return relevant.map((r: { node: { content: string } }) => r.node.content).join('\n');
  }

  return {
    async ingest(content: RawContent): Promise<PipelineResult> {
      const agentMemory = await getAgentMemory();
      const trustMemory = await getTrustMemory();

      const result = await runPipeline(content, {
        dataCube,
        model,
        openaiApiKey: config?.openaiApiKey,
        agentMemory,
        trustMemory,
      });

      // Record operational learnings
      const memory = await initMemory();
      await memory.record(
        `Processed ${result.node.entity_type} from ${content.source.origin}: ` +
        `extracted ${Object.keys(result.node.structured).length} fields, ` +
        `${result.edges.length} edges, ${result.conflicts.conflicts.length} conflicts`,
        { tags: ['pipeline', result.node.entity_type] },
      );

      return result;
    },

    async ingestFile(text: string, filePath: string, origin: string): Promise<PipelineResult[]> {
      const source = {
        origin,
        path: filePath,
        extracted_at: new Date().toISOString(),
        method: 'file-router',
      };

      const contentItems = routeFile(text, source);
      const results: PipelineResult[] = [];

      for (const item of contentItems) {
        const result = await this.ingest(item);
        results.push(result);
      }

      return results;
    },

    async cycle(): Promise<void> {
      currentCycle++;
      const memory = await initMemory();
      memory.setCycle(currentCycle);
      await memory.cycle();
    },

    getDataCube(): DataCube {
      return dataCube;
    },
  };
}
