// src/memory/graph/heuristic-graph-extractor.ts — deterministic graph extractor fallback
import { buildEdgeUri, buildEntityUri, extractKeywords } from "../scope.js";
import { resolveEntityRefs } from "../entity-resolution/resolver.js";
import type { MemoryCandidate, MemoryEntityRef, MemoryRelationRef, MemoryScopeSet, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryGraphExtractionResult, MemoryGraphExtractor } from "./extractor.js";

function dedupeEntities(entities: MemoryEntityRef[]): MemoryEntityRef[] {
  const out = new Map<string, MemoryEntityRef>();
  for (const entity of entities) {
    const prev = out.get(entity.entityUri);
    if (!prev || entity.confidence > prev.confidence) {
      out.set(entity.entityUri, entity);
    }
  }
  return [...out.values()];
}

function inferEntityType(token: string): string {
  if (/^\/[a-z0-9_]+$/i.test(token)) return "command";
  if (/^[A-Za-z]:[\\/]/.test(token) || /\//.test(token)) return "file";
  if (/pi-telegram/i.test(token)) return "repository";
  if (/spec|memory|bridge|telegram|workspace|project/i.test(token)) return "concept";
  return "concept";
}

function extractEntitiesFromText(text: string): MemoryEntityRef[] {
  const entities: MemoryEntityRef[] = [];
  for (const token of extractKeywords(text, 12)) {
    const entityType = inferEntityType(token);
    entities.push({
      entityUri: buildEntityUri(entityType, token),
      entityType,
      label: token,
      confidence: 0.7,
    });
  }
  return resolveEntityRefs(dedupeEntities(entities));
}

function maybeBehaviorRelation(candidate: Pick<MemoryCandidate, "plane" | "type">, entities: MemoryEntityRef[]): MemoryRelationRef[] {
  const user = entities.find((x) => x.entityType === "concept" || x.entityType === "command" || x.entityType === "repository");
  if (!user) return [];
  if (candidate.plane === "procedural") {
    return [{
      edgeUri: buildEdgeUri(buildEntityUri("user", "telegram-user"), "requires", user.entityUri),
      subjectUri: buildEntityUri("user", "telegram-user"),
      predicate: candidate.type === "behavior_correction" ? "corrects" : "requires",
      objectUri: user.entityUri,
      confidence: 0.68,
    }];
  }
  if (candidate.plane === "profile") {
    return [{
      edgeUri: buildEdgeUri(buildEntityUri("user", "telegram-user"), "prefers", user.entityUri),
      subjectUri: buildEntityUri("user", "telegram-user"),
      predicate: "prefers",
      objectUri: user.entityUri,
      confidence: 0.66,
    }];
  }
  return [];
}

export class HeuristicGraphExtractor implements MemoryGraphExtractor {
  extract(_request: MemoryTurnIngestRequest, _scopes: MemoryScopeSet, candidate: Pick<MemoryCandidate, "summary" | "canonicalText" | "plane" | "type">): MemoryGraphExtractionResult {
    const entities = extractEntitiesFromText(`${candidate.summary} ${candidate.canonicalText}`);
    const relations = maybeBehaviorRelation(candidate, entities);
    const eventType = candidate.type === "behavior_correction"
      ? "behavior_correction"
      : candidate.type === "behavior_rule"
        ? "project_decision"
        : candidate.type === "workspace_fact"
          ? "project_decision"
          : "answer";
    return {
      entities,
      relations,
      eventType,
    };
  }
}
