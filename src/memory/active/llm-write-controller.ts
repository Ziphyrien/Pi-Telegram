// src/memory/active/llm-write-controller.ts — optional LLM admission/operation decision overlay
import { MemoryJsonRunner } from "../llm/json-runner.js";
import type { MemoryCandidate, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryLlmConfig } from "../../shared/types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeOperation(value: unknown): string | undefined {
  const op = String(value || "").trim().toLowerCase();
  if (["add", "update", "replace", "delete", "noop", "link", "evolve"].includes(op)) return op;
  return undefined;
}

export class PiLlmWriteController {
  private readonly runner: MemoryJsonRunner;

  constructor(llm: MemoryLlmConfig, providerExtensionEntryPath?: string) {
    this.runner = new MemoryJsonRunner(llm, providerExtensionEntryPath);
  }

  async decide(request: MemoryTurnIngestRequest, candidates: MemoryCandidate[]): Promise<MemoryCandidate[] | undefined> {
    if (!candidates.length) return [];

    const payload = await this.runner.runJson({
      cwd: request.workspaceCwd,
      purpose: "write-control",
      prompt: [
        "你是 Pi-Telegram 的记忆写侧控制器。只输出严格 JSON。",
        "输出格式：{\"decisions\":[{\"canonicalUri\":string,\"admissionHint\":\"allow|reject\",\"operationHint\":\"add|update|replace|delete|noop|link|evolve\",\"reason\":string}]}。",
        "目标：对候选记忆做 admission control 与 operation decision。",
        "仅允许根据给定候选和当前对话做保守决策；不要编造新候选。",
        "对于 procedural/correction 可偏向 update；明显重复可 noop；明确被新规则覆盖时可 replace；证据不足应 reject。",
        `user: ${request.userText}`,
        `assistant: ${request.assistantText}`,
        `candidates: ${JSON.stringify(candidates.map((candidate) => ({
          canonicalUri: candidate.canonicalUri,
          familyUri: candidate.familyUri,
          plane: candidate.plane,
          temporalLevel: candidate.temporalLevel,
          scopeKind: candidate.scopeKind,
          type: candidate.type,
          summary: candidate.summary,
          canonicalText: candidate.canonicalText,
          importance: candidate.importance,
          confidence: candidate.confidence,
        })))}`,
      ].join("\n\n"),
    });

    const decisions = asRecord(payload)?.decisions;
    if (!Array.isArray(decisions)) return undefined;
    const byCanonical = new Map<string, { admissionHint?: string; operationHint?: string; reason?: string }>();

    for (const item of decisions) {
      const rec = asRecord(item);
      if (!rec) continue;
      const canonicalUri = String(rec.canonicalUri || "").trim();
      if (!canonicalUri) continue;
      const admissionHint = String(rec.admissionHint || "").trim().toLowerCase();
      const operationHint = normalizeOperation(rec.operationHint);
      byCanonical.set(canonicalUri, {
        admissionHint: admissionHint || undefined,
        operationHint,
        reason: typeof rec.reason === "string" ? rec.reason.trim() : undefined,
      });
    }

    return candidates.map((candidate) => {
      const decision = byCanonical.get(candidate.canonicalUri);
      if (!decision) return candidate;
      return {
        ...candidate,
        metadata: {
          ...candidate.metadata,
          admissionHint: decision.admissionHint,
          operationHint: decision.operationHint,
          operationReason: decision.reason,
          operationOrigin: "llm-write-controller",
        },
      };
    });
  }
}
