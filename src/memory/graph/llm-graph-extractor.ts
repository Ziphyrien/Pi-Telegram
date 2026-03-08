// src/memory/graph/llm-graph-extractor.ts — optional LLM-based entity/relation extraction layer
import { MemoryJsonRunner } from "../llm/json-runner.js";
import { normalizeEntities, normalizeRelations } from "../extraction/llm-extractor.js";
import type { MemoryCandidate, MemoryNodeRecord, MemoryScopeSet, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryLlmConfig } from "../../shared/types.js";
import type { MemoryGraphExtractionResult } from "./extractor.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class PiLlmGraphExtractor {
  private readonly runner: MemoryJsonRunner;

  constructor(llm: MemoryLlmConfig, providerExtensionEntryPath?: string) {
    this.runner = new MemoryJsonRunner(llm, providerExtensionEntryPath);
  }

  async extract(
    request: MemoryTurnIngestRequest,
    scopes: MemoryScopeSet,
    candidate: Pick<MemoryCandidate, "summary" | "canonicalText" | "plane" | "type">,
  ): Promise<MemoryGraphExtractionResult | undefined> {
    const payload = await this.runner.runJson({
      cwd: request.workspaceCwd,
      purpose: "graph-extract",
      prompt: [
        "你是 Pi-Telegram 的 memory graph extractor。只输出严格 JSON。",
        "输出格式：{\"eventType\":string,\"entities\":[{\"label\":string,\"entityType\":string,\"confidence\":number,\"entityUri\"?:string}],\"relations\":[{\"subjectLabel\"?:string,\"subjectUri\"?:string,\"predicate\":string,\"objectLabel\"?:string,\"objectUri\"?:string,\"confidence\":number}]}。",
        "目标：从给定 memory candidate 中抽取 entity / relation / eventType。",
        "关系词优先使用 canonical predicates，如 prefers/requires/corrects/works_on/implements/configures/related_to/summarizes/mentions。",
        "如果没有足够证据，可以返回空数组；不要编造实体。",
        `scopes: ${JSON.stringify({ chat: scopes.chat.uri, user: scopes.user?.uri ?? null, workspace: scopes.workspace.uri })}`,
        `plane: ${candidate.plane}`,
        `type: ${candidate.type}`,
        `summary: ${candidate.summary}`,
        `canonicalText: ${candidate.canonicalText}`,
      ].join("\n\n"),
    });

    const rec = asRecord(payload);
    if (!rec) return undefined;
    const entities = normalizeEntities(rec.entities);
    const relations = normalizeRelations(rec.relations, entities);
    const eventType = typeof rec.eventType === "string" && rec.eventType.trim()
      ? rec.eventType.trim()
      : undefined;
    return { entities, relations, eventType };
  }

  async extractFromNode(
    request: MemoryTurnIngestRequest,
    scopes: MemoryScopeSet,
    node: Pick<MemoryNodeRecord, "summary" | "canonicalText" | "plane" | "type">,
  ): Promise<MemoryGraphExtractionResult | undefined> {
    return this.extract(request, scopes, node);
  }
}
