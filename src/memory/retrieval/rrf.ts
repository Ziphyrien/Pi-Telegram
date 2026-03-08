// src/memory/retrieval/rrf.ts — reciprocal rank fusion for multi-channel candidate fusion
import type { MemoryNodeRecord } from "../types.js";

export interface RankedChannelList {
  channel: string;
  nodes: MemoryNodeRecord[];
  weight?: number;
}

export function reciprocalRankFusion(lists: RankedChannelList[], k = 60): Array<{ node: MemoryNodeRecord; score: number; channels: string[] }> {
  const scores = new Map<string, { node: MemoryNodeRecord; score: number; channels: Set<string> }>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.nodes.forEach((node, index) => {
      const key = node.canonicalUri;
      const current = scores.get(key) ?? { node, score: 0, channels: new Set<string>() };
      current.score += weight * (1 / (k + index + 1));
      current.channels.add(list.channel);
      scores.set(key, current);
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((item) => ({ node: item.node, score: item.score, channels: [...item.channels] }));
}
