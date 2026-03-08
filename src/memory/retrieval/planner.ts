// src/memory/retrieval/planner.ts — retrieval planner contracts
import type { MemoryPlane, MemoryPromptContextRequest, MemoryScopeKind, MemoryTemporalLevel } from "../types.js";

export type MemoryQueryComplexity = "simple" | "hybrid" | "complex";
export type MemoryRetrievalChannel = "dense" | "sparse" | "graph" | "temporal" | "recent";

export interface MemoryRetrievalPlan {
  complexity: MemoryQueryComplexity;
  searchTerms: string[];
  clues: string[];
  targetPlanes: MemoryPlane[];
  targetLevels: MemoryTemporalLevel[];
  targetChannels: MemoryRetrievalChannel[];
  scopeHints: MemoryScopeKind[];
  maxCandidates: number;
  maxFinalMemories: number;
  maxRecentTurns: number;
}

export interface MemoryRetrievalPlanner {
  plan(request: MemoryPromptContextRequest, limits: {
    maxRetrievedMemories: number;
    maxRecentTurns: number;
  }): MemoryRetrievalPlan;
}
