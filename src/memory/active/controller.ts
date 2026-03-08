// src/memory/active/controller.ts — active memory controller as read-side control overlay
import type { MemoryPromptContextRequest } from "../types.js";
import type { MemoryHybridRetriever, MemoryRetrievalResult } from "../retrieval/hybrid-search.js";
import { extractKeywords } from "../scope.js";

function mergeUnique<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function primaryEvidenceGap(result: MemoryRetrievalResult): string | undefined {
  return result.evidenceGap[0];
}

export class MemoryActiveController {
  constructor(private readonly retriever: MemoryHybridRetriever) {}

  async retrieve(request: MemoryPromptContextRequest, limits: {
    maxRetrievedMemories: number;
    maxRecentTurns: number;
  }): Promise<{
    result: MemoryRetrievalResult;
    iterations: number;
    mode: "single-pass" | "closed-loop";
    evidenceGap?: string;
  }> {
    const first = await this.retriever.retrieve(request, limits);
    const firstGap = primaryEvidenceGap(first);
    if (first.plan.complexity !== "complex") {
      return { result: first, iterations: 1, mode: "single-pass", evidenceGap: firstGap };
    }

    if (!firstGap) {
      return { result: first, iterations: 1, mode: "closed-loop" };
    }

    const reflectiveTerms = extractKeywords([
      request.prompt,
      ...first.plan.clues,
      ...first.evidenceGap,
      first.recentTurns.map((x) => x.content).join("\n"),
      first.nodes.map((x) => x.summary).join("\n"),
    ].join("\n"), 12);

    const second = await this.retriever.retrieve({
      ...request,
      prompt: [request.prompt, ...reflectiveTerms].filter(Boolean).join("\n"),
    }, limits);

    return {
      result: {
        plan: second.plan,
        nodes: mergeUnique([...first.nodes, ...second.nodes], (x) => x.canonicalUri),
        recentTurns: mergeUnique([...first.recentTurns, ...second.recentTurns], (x) => x.turnUri),
        evidenceGap: second.evidenceGap.length ? second.evidenceGap : first.evidenceGap,
        channelCoverage: second.channelCoverage.size ? second.channelCoverage : first.channelCoverage,
        noveltyByUri: new Map([...first.noveltyByUri, ...second.noveltyByUri]),
        clusterCount: Math.max(first.clusterCount, second.clusterCount),
      },
      iterations: 2,
      mode: "closed-loop",
      evidenceGap: firstGap,
    };
  }
}
