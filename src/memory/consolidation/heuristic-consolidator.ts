// src/memory/consolidation/heuristic-consolidator.ts — deterministic temporal promotion fallback
import { buildCanonicalUri } from "../scope.js";
import type { MemoryCandidate, MemoryNodeRecord } from "../types.js";
import type { MemoryConsolidator } from "./consolidator.js";

interface PromotionStep {
  level: MemoryCandidate["temporalLevel"];
  importanceDelta: number;
  confidenceDelta: number;
  temperature: MemoryCandidate["temperature"];
}

function buildPromotionPlan(node: MemoryNodeRecord): PromotionStep[] {
  if (node.temporalLevel !== "T1") return [];
  switch (node.plane) {
    case "episodic":
      return [{ level: "T2", importanceDelta: 0.06, confidenceDelta: 0.03, temperature: "warm" }];
    case "profile":
      return [
        { level: "T3", importanceDelta: 0.08, confidenceDelta: 0.04, temperature: "warm" },
        { level: "T5", importanceDelta: 0.1, confidenceDelta: 0.05, temperature: "warm" },
      ];
    case "project":
      return [
        { level: "T2", importanceDelta: 0.06, confidenceDelta: 0.03, temperature: "warm" },
        { level: "T4", importanceDelta: 0.08, confidenceDelta: 0.04, temperature: "warm" },
        { level: "T5", importanceDelta: 0.1, confidenceDelta: 0.05, temperature: "warm" },
      ];
    case "procedural":
      return [{ level: "T5", importanceDelta: 0.08, confidenceDelta: 0.04, temperature: "hot" }];
    default:
      return [];
  }
}

export class HeuristicConsolidator implements MemoryConsolidator {
  consolidate(nodes: MemoryNodeRecord[]): MemoryCandidate[] {
    const out: MemoryCandidate[] = [];
    for (const node of nodes) {
      const plan = buildPromotionPlan(node);
      let derivedFrom = node.canonicalUri;
      for (const step of plan) {
        const canonicalUri = buildCanonicalUri(node.plane, node.scopeKind, node.scopeId, `${node.summary}|${step.level}`);
        out.push({
          canonicalUri,
          familyUri: node.familyUri,
          scopeKind: node.scopeKind,
          scopeId: node.scopeId,
          scopeUri: node.scopeUri,
          plane: node.plane,
          temporalLevel: step.level,
          type: node.type,
          summary: node.summary,
          canonicalText: node.canonicalText,
          keywords: node.keywords,
          importance: Math.min(1, node.importance + step.importanceDelta),
          confidence: Math.min(1, node.confidence + step.confidenceDelta),
          temperature: step.temperature,
          sourceKind: node.sourceKind,
          sourceChatId: node.sourceChatId,
          userId: node.userId,
          workspaceId: node.workspaceId,
          eventType: node.eventType,
          entities: undefined,
          relations: undefined,
          sourceTurnUris: undefined,
          metadata: {
            origin: "heuristic-consolidator",
            derivedFrom,
            sourceTemporalLevel: node.temporalLevel,
          },
          upsertByFamily: true,
        });
        derivedFrom = canonicalUri;
      }
    }
    return out;
  }
}
