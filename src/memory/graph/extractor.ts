// src/memory/graph/extractor.ts — entity/relation extraction contracts
import type { MemoryCandidate, MemoryEntityRef, MemoryRelationRef, MemoryScopeSet, MemoryTurnIngestRequest } from "../types.js";

export interface MemoryGraphExtractionResult {
  entities: MemoryEntityRef[];
  relations: MemoryRelationRef[];
  eventType?: string;
}

export interface MemoryGraphExtractor {
  extract(request: MemoryTurnIngestRequest, scopes: MemoryScopeSet, candidate: Pick<MemoryCandidate, "summary" | "canonicalText" | "plane" | "type">): MemoryGraphExtractionResult;
}
