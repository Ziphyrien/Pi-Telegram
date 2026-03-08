// src/memory/retrieval/ppr.ts — personalized page rank over candidate graph
export interface PprNode<T> {
  id: string;
  value: T;
}

export interface PprEdge {
  from: string;
  to: string;
  weight?: number;
}

export function personalizedPageRank<T>(nodes: PprNode<T>[], edges: PprEdge[], seedIds: string[], alpha = 0.85, iterations = 12): Array<{ node: PprNode<T>; score: number }> {
  if (!nodes.length) return [];
  const nodeIds = nodes.map((node) => node.id);
  const allIds = new Set(nodeIds);
  const seeds = seedIds.filter((id) => allIds.has(id));
  const teleport = new Map<string, number>();
  const teleportBase = seeds.length ? 1 / seeds.length : 1 / nodeIds.length;
  for (const id of seeds.length ? seeds : nodeIds) {
    teleport.set(id, teleportBase);
  }

  const outgoing = new Map<string, Array<{ to: string; weight: number }>>();
  for (const edge of edges) {
    if (!allIds.has(edge.from) || !allIds.has(edge.to)) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push({ to: edge.to, weight: edge.weight ?? 1 });
    outgoing.set(edge.from, list);
  }

  let scores = new Map<string, number>(nodeIds.map((id) => [id, 1 / nodeIds.length]));
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Map<string, number>(nodeIds.map((id) => [id, (1 - alpha) * (teleport.get(id) ?? 0)]));
    for (const id of nodeIds) {
      const current = scores.get(id) ?? 0;
      const links = outgoing.get(id) ?? [];
      if (!links.length) {
        const spread = alpha * current / nodeIds.length;
        for (const target of nodeIds) {
          next.set(target, (next.get(target) ?? 0) + spread);
        }
        continue;
      }
      const totalWeight = links.reduce((sum, link) => sum + link.weight, 0) || 1;
      for (const link of links) {
        next.set(link.to, (next.get(link.to) ?? 0) + alpha * current * (link.weight / totalWeight));
      }
    }
    scores = next;
  }

  return nodes
    .map((node) => ({ node, score: scores.get(node.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}
