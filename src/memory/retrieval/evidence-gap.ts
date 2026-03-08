// src/memory/retrieval/evidence-gap.ts — evidence gap analysis for retrieval control
import type { MemoryNodeRecord } from "../types.js";
import type { MemoryRetrievalPlan } from "./planner.js";

export interface EvidenceGapAnalysis {
  gaps: string[];
  severe: boolean;
}

export function analyzeEvidenceGap(plan: MemoryRetrievalPlan, nodes: MemoryNodeRecord[], channelCoverage: Map<string, string[]>): EvidenceGapAnalysis {
  const gaps: string[] = [];
  const planes = new Set(nodes.map((node) => node.plane));
  const levels = new Set(nodes.map((node) => node.temporalLevel));

  for (const plane of plan.targetPlanes) {
    if (!planes.has(plane)) gaps.push(`missing-plane:${plane}`);
  }
  if (plan.complexity === "complex") {
    for (const level of plan.targetLevels) {
      if (!levels.has(level)) gaps.push(`missing-level:${level}`);
    }
  }
  for (const channel of plan.targetChannels) {
    if (!channelCoverage.has(channel)) gaps.push(`missing-channel:${channel}`);
  }
  if (nodes.length < Math.max(2, Math.floor(plan.maxFinalMemories / 2))) {
    gaps.push("insufficient-candidates");
  }

  return {
    gaps,
    severe: gaps.some((gap) => gap.startsWith("missing-plane") || gap === "insufficient-candidates"),
  };
}
