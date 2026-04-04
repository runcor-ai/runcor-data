// Stage 5: Persist — write entity and edges to the data cube

import type { DataCube } from '../data-cube.js';
import type { DataNode, DataEdge, DataSource, RelateResult, ConflictResult } from '../types.js';

export interface PersistInput {
  entity_type: string;
  content: string;
  structured: Record<string, unknown>;
  confidence: number;
  source: DataSource;
  relateResult: RelateResult;
  conflictResult: ConflictResult;
}

export interface PersistOutput {
  node: DataNode;
  edges: DataEdge[];
}

/** Persist entity and all discovered edges to the data cube */
export async function persist(
  input: PersistInput,
  dataCube: DataCube,
): Promise<PersistOutput> {
  const now = new Date().toISOString();

  // Create the node
  const node = await dataCube.persist({
    entity_type: input.entity_type,
    content: input.content,
    structured: input.structured,
    confidence: input.confidence,
    source: input.source,
    version: 1,
    created_at: now,
    updated_at: now,
  });

  const edges: DataEdge[] = [];

  // Add relationship edges from the relate stage
  for (const match of input.relateResult.matches) {
    dataCube.addEdge({
      from_id: node.id,
      to_id: match.node_id,
      type: match.edge_type,
      weight: match.weight,
      evidence: match.evidence,
    });

    edges.push({
      from_id: node.id,
      to_id: match.node_id,
      type: match.edge_type,
      weight: match.weight,
      evidence: match.evidence,
      created_at: now,
    });
  }

  // Add conflict edges where values disagree
  for (const conflict of input.conflictResult.conflicts) {
    if (conflict.resolution === 'escalate') {
      dataCube.addEdge({
        from_id: node.id,
        to_id: conflict.existing_node_id,
        type: 'conflicts',
        weight: 0.5,
        evidence: `Field "${conflict.field}": new="${JSON.stringify(conflict.new_value)}" vs existing="${JSON.stringify(conflict.existing_value)}". ${conflict.reason}`,
      });

      edges.push({
        from_id: node.id,
        to_id: conflict.existing_node_id,
        type: 'conflicts',
        weight: 0.5,
        evidence: `Unresolved conflict on "${conflict.field}"`,
        created_at: now,
      });
    } else if (conflict.resolution === 'new_wins') {
      // Update the existing node's field with the new value
      const existing = dataCube.getById(conflict.existing_node_id);
      if (existing) {
        const updatedStructured = { ...existing.structured };
        updatedStructured[conflict.field] = conflict.new_value;
        await dataCube.update(conflict.existing_node_id, { structured: updatedStructured });

        // Add supersedes edge
        dataCube.addEdge({
          from_id: node.id,
          to_id: conflict.existing_node_id,
          type: 'supersedes',
          weight: 0.8,
          evidence: `Field "${conflict.field}" updated: ${JSON.stringify(conflict.existing_value)} → ${JSON.stringify(conflict.new_value)}. ${conflict.reason}`,
        });
      }
    }
    // If existing_wins, no update needed — existing value stays
  }

  return { node, edges };
}
