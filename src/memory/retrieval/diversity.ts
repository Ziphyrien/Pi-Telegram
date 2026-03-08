// src/memory/retrieval/diversity.ts — MMR and novelty scoring helpers
import type { MemoryEntityRef, MemoryNodeRecord } from "../types.js";
import { colbertLateInteractionScore } from "./colbert.js";

export interface RetrievalCandidateScore {
  node: MemoryNodeRecord;
  relevance: number;
  entities?: MemoryEntityRef[];
  channels?: string[];
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const item of setA) {
    if (setB.has(item)) overlap += 1;
  }
  const union = setA.size + setB.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function entitySimilarity(a: MemoryEntityRef[] = [], b: MemoryEntityRef[] = []): number {
  return jaccard(a.map((x) => x.entityUri), b.map((x) => x.entityUri));
}

export function candidateSimilarity(a: RetrievalCandidateScore, b: RetrievalCandidateScore): number {
  if (a.node.familyUri === b.node.familyUri) return 1;
  const keyword = jaccard(a.node.keywords, b.node.keywords);
  const entity = entitySimilarity(a.entities, b.entities);
  const late = colbertLateInteractionScore(a.node.summary, b.node);
  const planePenalty = a.node.plane === b.node.plane ? 0.1 : 0;
  return Math.max(keyword * 0.45 + entity * 0.45 + late * 0.1 + planePenalty, 0);
}

export function noveltyScore(candidate: RetrievalCandidateScore, selected: RetrievalCandidateScore[]): number {
  if (!selected.length) return 1;
  const maxSimilarity = Math.max(...selected.map((item) => candidateSimilarity(candidate, item)));
  return Math.max(0, 1 - maxSimilarity);
}

export function mmrSelect(candidates: RetrievalCandidateScore[], limit: number, lambda = 0.72): RetrievalCandidateScore[] {
  const remaining = [...candidates];
  const selected: RetrievalCandidateScore[] = [];

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const redundancy = selected.length ? Math.max(...selected.map((item) => candidateSimilarity(candidate, item))) : 0;
      const score = lambda * candidate.relevance - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}
