// src/memory/ingest/extractor.ts — candidate extraction contracts
import type { MemoryCandidate, MemoryScopeSet, MemoryTurnIngestRequest } from "../types.js";

export interface MemoryCandidateExtractor {
  extract(request: MemoryTurnIngestRequest, scopes: MemoryScopeSet): MemoryCandidate[];
}
