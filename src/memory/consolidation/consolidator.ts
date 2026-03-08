// src/memory/consolidation/consolidator.ts — consolidation contracts
import type { MemoryCandidate, MemoryNodeRecord } from "../types.js";

export interface MemoryConsolidator {
  consolidate(nodes: MemoryNodeRecord[]): MemoryCandidate[];
}
