// src/memory/retrieval/clustering.ts — recursive clustering for candidate organization
import type { MemoryEntityRef, MemoryNodeRecord } from "../types.js";

export interface MemoryCluster {
  key: string;
  label: string;
  nodes: MemoryNodeRecord[];
  children: MemoryCluster[];
}

function dominantEntityLabel(entities: MemoryEntityRef[] = []): string | undefined {
  return entities
    .slice()
    .sort((a, b) => b.confidence - a.confidence)[0]?.label;
}

function buildClusterKey(node: MemoryNodeRecord, entities?: MemoryEntityRef[]): string {
  return dominantEntityLabel(entities) || node.familyUri || `${node.plane}:${node.temporalLevel}`;
}

export function recursiveClusterNodes(
  nodes: MemoryNodeRecord[],
  entityMap: Map<string, MemoryEntityRef[]>,
  depth = 0,
  maxDepth = 2,
): MemoryCluster[] {
  if (!nodes.length) return [];
  if (depth >= maxDepth || nodes.length <= 2) {
    return nodes.map((node) => ({
      key: node.canonicalUri,
      label: node.summary,
      nodes: [node],
      children: [],
    }));
  }

  const buckets = new Map<string, MemoryNodeRecord[]>();
  for (const node of nodes) {
    const key = depth === 0
      ? node.plane
      : buildClusterKey(node, entityMap.get(node.canonicalUri));
    const list = buckets.get(key) ?? [];
    list.push(node);
    buckets.set(key, list);
  }

  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: key,
    nodes: bucket,
    children: recursiveClusterNodes(bucket, entityMap, depth + 1, maxDepth),
  }));
}

export function flattenRecursiveClusters(clusters: MemoryCluster[]): MemoryNodeRecord[] {
  const out: MemoryNodeRecord[] = [];
  for (const cluster of clusters) {
    const representative = cluster.nodes[0];
    if (representative) out.push(representative);
    if (cluster.children.length) {
      for (const node of flattenRecursiveClusters(cluster.children)) {
        if (!out.some((item) => item.canonicalUri === node.canonicalUri)) {
          out.push(node);
        }
      }
    }
  }
  return out;
}
