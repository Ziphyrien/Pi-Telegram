// src/memory/retrieval/llm-participant.ts — LLM participation layer for retrieval planning and reranking
import { MemoryJsonRunner } from "../llm/json-runner.js";
import type { MemoryNodeRecord, MemoryPlane, MemoryPromptContextRequest, MemoryScopeKind, MemoryTemporalLevel } from "../types.js";
import type { MemoryLlmConfig } from "../../shared/types.js";
import type { MemoryRetrievalChannel, MemoryRetrievalPlan } from "./planner.js";

function clampInt(input: unknown, min: number, max: number, fallback: number): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeComplexity(value: unknown, fallback: MemoryRetrievalPlan["complexity"]): MemoryRetrievalPlan["complexity"] {
  switch (String(value || "").trim()) {
    case "simple": return "simple";
    case "hybrid": return "hybrid";
    case "complex": return "complex";
    default:
      return fallback;
  }
}

function normalizeSearchTerms(value: unknown, fallback: string[]): string[] {
  const terms = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return terms.length ? terms.slice(0, 12) : fallback;
}

function normalizePlanes(value: unknown, fallback: MemoryPlane[]): MemoryPlane[] {
  const allowed = new Set<MemoryPlane>(["episodic", "profile", "project", "procedural"]);
  const planes = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter((item): item is MemoryPlane => allowed.has(item as MemoryPlane))
    : [];
  return planes.length ? [...new Set(planes)] : fallback;
}

function normalizeLevels(value: unknown, fallback: MemoryTemporalLevel[]): MemoryTemporalLevel[] {
  const allowed = new Set<MemoryTemporalLevel>(["T1", "T2", "T3", "T4", "T5"]);
  const levels = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter((item): item is MemoryTemporalLevel => allowed.has(item as MemoryTemporalLevel))
    : [];
  return levels.length ? [...new Set(levels)] : fallback;
}

function normalizeChannels(value: unknown, fallback: MemoryRetrievalChannel[]): MemoryRetrievalChannel[] {
  const allowed = new Set<MemoryRetrievalChannel>(["dense", "sparse", "graph", "temporal", "recent"]);
  const channels = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter((item): item is MemoryRetrievalChannel => allowed.has(item as MemoryRetrievalChannel))
    : [];
  return channels.length ? [...new Set(channels)] : fallback;
}

function normalizeScopes(value: unknown, fallback: MemoryScopeKind[]): MemoryScopeKind[] {
  const allowed = new Set<MemoryScopeKind>(["chat-local", "user-global", "workspace-global", "system-global"]);
  const scopes = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter((item): item is MemoryScopeKind => allowed.has(item as MemoryScopeKind))
    : [];
  return scopes.length ? [...new Set(scopes)] : fallback;
}

function normalizeClues(value: unknown, fallback: string[]): string[] {
  const clues = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return clues.length ? clues.slice(0, 12) : fallback;
}

function orderByUris(nodes: MemoryNodeRecord[], uris: string[], maxFinalMemories: number): MemoryNodeRecord[] {
  if (!uris.length) return nodes.slice(0, maxFinalMemories);
  const byUri = new Map(nodes.map((node) => [node.canonicalUri, node]));
  const selected: MemoryNodeRecord[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const node = byUri.get(uri);
    if (!node || seen.has(uri)) continue;
    seen.add(uri);
    selected.push(node);
    if (selected.length >= maxFinalMemories) return selected;
  }
  for (const node of nodes) {
    if (seen.has(node.canonicalUri)) continue;
    selected.push(node);
    if (selected.length >= maxFinalMemories) break;
  }
  return selected;
}

export class PiLlmRetrievalParticipant {
  private readonly runner: MemoryJsonRunner;

  constructor(llm: MemoryLlmConfig, providerExtensionEntryPath?: string) {
    this.runner = new MemoryJsonRunner(llm, providerExtensionEntryPath);
  }

  async plan(
    request: MemoryPromptContextRequest,
    fallback: MemoryRetrievalPlan,
    limits: { maxRetrievedMemories: number; maxRecentTurns: number },
  ): Promise<MemoryRetrievalPlan | undefined> {
    const payload = await this.runner.runJson({
      cwd: request.workspaceCwd,
      purpose: "retrieval-plan",
      prompt: [
        "你是 Pi-Telegram 的记忆检索 planner。只输出严格 JSON。",
        "输出格式：{\"complexity\":\"simple|hybrid|complex\",\"searchTerms\":[...],\"clues\":[...],\"targetPlanes\":[...],\"targetLevels\":[...],\"targetChannels\":[...],\"scopeHints\":[...],\"maxCandidates\":number,\"maxFinalMemories\":number,\"maxRecentTurns\":number}。",
        "targetPlanes 只能是 episodic/profile/project/procedural。",
        "targetLevels 只能是 T1/T2/T3/T4/T5。",
        "targetChannels 只能是 dense/sparse/graph/temporal/recent。",
        "scopeHints 只能是 chat-local/user-global/workspace-global。",
        "请在保守前提下规划 retrieval，不要编造工具，不要回答用户问题本身。",
        `request: ${request.prompt}`,
        `fallbackPlan: ${JSON.stringify(fallback)}`,
        `limits: ${JSON.stringify(limits)}`,
      ].join("\n\n"),
    });

    const rec = asRecord(payload);
    if (!rec) return undefined;

    return {
      complexity: normalizeComplexity(rec.complexity, fallback.complexity),
      searchTerms: normalizeSearchTerms(rec.searchTerms, fallback.searchTerms),
      clues: normalizeClues(rec.clues, fallback.clues),
      targetPlanes: normalizePlanes(rec.targetPlanes, fallback.targetPlanes),
      targetLevels: normalizeLevels(rec.targetLevels, fallback.targetLevels),
      targetChannels: normalizeChannels(rec.targetChannels, fallback.targetChannels),
      scopeHints: normalizeScopes(rec.scopeHints, fallback.scopeHints),
      maxCandidates: clampInt(rec.maxCandidates, fallback.maxFinalMemories, Math.max(64, limits.maxRetrievedMemories * 4), fallback.maxCandidates),
      maxFinalMemories: clampInt(rec.maxFinalMemories, 1, Math.max(16, limits.maxRetrievedMemories), fallback.maxFinalMemories),
      maxRecentTurns: clampInt(rec.maxRecentTurns, 0, Math.max(12, limits.maxRecentTurns), fallback.maxRecentTurns),
    };
  }

  async rerank(
    request: MemoryPromptContextRequest,
    plan: MemoryRetrievalPlan,
    nodes: MemoryNodeRecord[],
  ): Promise<MemoryNodeRecord[] | undefined> {
    if (!nodes.length) return [];

    const payload = await this.runner.runJson({
      cwd: request.workspaceCwd,
      purpose: "retrieval-rerank",
      prompt: [
        "你是 Pi-Telegram 的记忆 reranker。只输出严格 JSON。",
        "输出格式：{\"selectedUris\":[...],\"collapsedFamilies\":[{\"familyUri\":string,\"keptUri\":string}],\"notes\":[...]}。",
        "你只能从给定候选中选择 URI，不得编造新的 URI。",
        `query: ${request.prompt}`,
        `plan: ${JSON.stringify(plan)}`,
        `candidates: ${JSON.stringify(nodes.map((node) => ({
          canonicalUri: node.canonicalUri,
          familyUri: node.familyUri,
          plane: node.plane,
          temporalLevel: node.temporalLevel,
          summary: node.summary,
          importance: node.importance,
          confidence: node.confidence,
          updatedAt: node.updatedAt,
        })))}`,
      ].join("\n\n"),
    });

    const rec = asRecord(payload);
    if (!rec) return undefined;
    const selectedUris = Array.isArray(rec.selectedUris)
      ? rec.selectedUris.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    return orderByUris(nodes, selectedUris, plan.maxFinalMemories);
  }
}
