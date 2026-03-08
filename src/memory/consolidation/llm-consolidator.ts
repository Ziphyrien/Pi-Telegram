// src/memory/consolidation/llm-consolidator.ts — semantic-guided consolidation via internal memory LLM runner
import { buildWorkspaceId, resolveScopeSet } from "../scope.js";
import { MemoryJsonRunner } from "../llm/json-runner.js";
import { normalizeCandidates } from "../extraction/llm-extractor.js";
import type { MemoryCandidate, MemoryNodeRecord, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryLlmConfig } from "../../shared/types.js";

export class PiLlmConsolidator {
  private readonly runner: MemoryJsonRunner;

  constructor(llm: MemoryLlmConfig, providerExtensionEntryPath?: string) {
    this.runner = new MemoryJsonRunner(llm, providerExtensionEntryPath);
  }

  async consolidate(request: MemoryTurnIngestRequest, nodes: MemoryNodeRecord[]): Promise<MemoryCandidate[] | undefined> {
    if (!nodes.length) return [];
    const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
    const payload = await this.runner.runJson({
      cwd: request.workspaceCwd,
      purpose: "consolidation",
      prompt: [
        "你是 Pi-Telegram 的层级记忆巩固器。只输出严格 JSON。",
        "目标：把给定的 T1 记忆巩固成更高层级的 T2/T3/T4/T5 memory candidates。",
        "输出格式：{\"memories\":[...]}。字段与 candidate extraction 相同。",
        "不要编造新的事实；只允许根据输入节点做更高层抽象、归纳和稳定约束提炼。",
        "若某条输入不适合提升，就不要输出。",
        "对于 procedural，可直接产出 T5 规则；对于 profile，优先 T3/T5；对于 project，优先 T2/T4/T5；对于 episodic，可输出 T2。",
        `workspaceId: ${buildWorkspaceId(request.workspaceCwd)}`,
        `availableScopes: ${JSON.stringify({ chat: scopes.chat.uri, user: scopes.user?.uri ?? null, workspace: scopes.workspace.uri })}`,
        `sourceNodes: ${JSON.stringify(nodes.map((node) => ({
          canonicalUri: node.canonicalUri,
          familyUri: node.familyUri,
          plane: node.plane,
          temporalLevel: node.temporalLevel,
          scopeKind: node.scopeKind,
          summary: node.summary,
          canonicalText: node.canonicalText,
          importance: node.importance,
          confidence: node.confidence,
          keywords: node.keywords,
        })))}`,
      ].join("\n\n"),
    });

    const normalized = normalizeCandidates(payload, request, scopes)
      .map((candidate) => ({
        ...candidate,
        metadata: {
          ...candidate.metadata,
          origin: "llm-consolidator",
        },
      }))
      .filter((candidate) => candidate.temporalLevel !== "T1");

    return normalized.length ? normalized : undefined;
  }
}
