// src/memory/ingest/heuristic-extractor.ts — conservative fallback candidate extractor
import { buildCanonicalUri, buildFamilyUri, buildWorkspaceId, extractKeywords, normalizeTextForKey } from "../scope.js";
import type { MemoryCandidate, MemoryScopeRef, MemoryScopeSet, MemorySourceKind, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryCandidateExtractor } from "./extractor.js";

const PROCEDURAL_PATTERNS = [
  /以后(?:都|请|一律)/,
  /统一按/,
  /统一.+行为/,
  /不要再/,
  /别再/,
  /请记住/,
  /记住这个/,
  /以后这样做/,
  /先写\s*spec/iu,
  /先写规格/,
  /不要直接实现/,
  /不要立刻实现/,
  /请用中文(?:回答|回复|输出)?/,
  /中文(?:回答|回复|输出)/,
  /请简洁(?:一点)?/,
];

const USER_PROFILE_PATTERNS = [
  /我喜欢/,
  /我不喜欢/,
  /我偏好/,
  /我的偏好/,
  /我习惯/,
  /我通常会/,
];

const WORKSPACE_SCOPE_PATTERNS = [
  /当前项目/,
  /这个项目/,
  /当前仓库/,
  /这个仓库/,
  /工作区/,
  /代码库/,
  /本项目/,
  /本仓库/,
];

const WORKSPACE_DURABLE_PATTERNS = [
  /架构/,
  /规范/,
  /约束/,
  /流程/,
  /目录结构/,
  /命名/,
  /接口/,
  /模块/,
  /版本/,
  /发布/,
  /工作流/,
  /策略/,
];

function clamp01(input: number): number {
  return Math.max(0, Math.min(1, input));
}

function splitSentences(text: string): string[] {
  return String(text || "")
    .split(/[\n。！？!?；;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function truncate(input: string, max = 220): string {
  const text = String(input || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function chooseScope(sentence: string, scopes: MemoryScopeSet): MemoryScopeRef {
  if (WORKSPACE_SCOPE_PATTERNS.some((re) => re.test(sentence))) {
    return scopes.workspace;
  }
  if (USER_PROFILE_PATTERNS.some((re) => re.test(sentence)) && scopes.user) {
    return scopes.user;
  }
  return scopes.chat;
}

function createCandidate(params: {
  summary: string;
  canonicalText: string;
  plane: MemoryCandidate["plane"];
  temporalLevel: MemoryCandidate["temporalLevel"];
  type: string;
  scope: MemoryScopeRef;
  sourceKind: MemorySourceKind;
  sourceChatId: number;
  userId?: number;
  workspaceId: string;
  importance: number;
  confidence: number;
  temperature: MemoryCandidate["temperature"];
  metadata?: Record<string, unknown>;
  upsertByFamily?: boolean;
}): MemoryCandidate {
  const familyUri = buildFamilyUri(params.plane, params.scope.kind, params.scope.id, params.summary);
  const upsertByFamily = params.upsertByFamily ?? true;
  const canonicalSeed = upsertByFamily
    ? params.summary
    : `${params.summary}|${params.canonicalText}|${Date.now()}|${Math.random()}`;
  return {
    canonicalUri: buildCanonicalUri(params.plane, params.scope.kind, params.scope.id, canonicalSeed),
    familyUri,
    scopeKind: params.scope.kind,
    scopeId: params.scope.id,
    scopeUri: params.scope.uri,
    plane: params.plane,
    temporalLevel: params.temporalLevel,
    type: params.type,
    summary: truncate(params.summary, 180),
    canonicalText: truncate(params.canonicalText, 600),
    keywords: extractKeywords(`${params.summary} ${params.canonicalText}`),
    importance: clamp01(params.importance),
    confidence: clamp01(params.confidence),
    temperature: params.temperature,
    sourceKind: params.sourceKind,
    sourceChatId: params.sourceChatId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    metadata: params.metadata,
    upsertByFamily,
  };
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const byKey = new Map<string, MemoryCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.familyUri}|${normalizeTextForKey(candidate.summary)}`;
    const previous = byKey.get(key);
    if (!previous || candidate.importance > previous.importance) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function buildEpisodicSummary(userText: string, assistantText: string): string {
  const userPart = truncate(userText, 80);
  const assistantPart = truncate(assistantText, 100);
  return `用户：${userPart} | 助手：${assistantPart}`;
}

export class HeuristicCandidateExtractor implements MemoryCandidateExtractor {
  extract(request: MemoryTurnIngestRequest, scopes: MemoryScopeSet): MemoryCandidate[] {
    const workspaceId = buildWorkspaceId(request.workspaceCwd);
    const sentences = splitSentences(request.userText);
    const candidates: MemoryCandidate[] = [];

    for (const sentence of sentences) {
      const isProcedural = PROCEDURAL_PATTERNS.some((re) => re.test(sentence));
      const isProfile = USER_PROFILE_PATTERNS.some((re) => re.test(sentence));
      const isWorkspace = WORKSPACE_SCOPE_PATTERNS.some((re) => re.test(sentence))
        && WORKSPACE_DURABLE_PATTERNS.some((re) => re.test(sentence));

      if (isProcedural || isProfile) {
        const scope = chooseScope(sentence, scopes);
        const plane = isProcedural ? "procedural" : "profile";
        const type = isProcedural
          ? (/不要|别再|纠正|改成/.test(sentence) ? "behavior_correction" : "behavior_rule")
          : "user_preference";

        candidates.push(createCandidate({
          summary: sentence,
          canonicalText: sentence,
          plane,
          temporalLevel: "T1",
          type,
          scope,
          sourceKind: request.source,
          sourceChatId: request.chatId,
          userId: request.userId,
          workspaceId,
          importance: plane === "procedural" ? 0.95 : 0.8,
          confidence: plane === "procedural" ? 0.9 : 0.78,
          temperature: plane === "procedural" ? "hot" : "warm",
          metadata: { origin: "heuristic-stable-extraction", botName: request.botName },
        }));
        continue;
      }

      if (isWorkspace) {
        candidates.push(createCandidate({
          summary: sentence,
          canonicalText: sentence,
          plane: "project",
          temporalLevel: "T1",
          type: "workspace_fact",
          scope: scopes.workspace,
          sourceKind: request.source,
          sourceChatId: request.chatId,
          userId: request.userId,
          workspaceId,
          importance: 0.66,
          confidence: 0.7,
          temperature: "warm",
          metadata: { origin: "heuristic-workspace-fact", botName: request.botName },
        }));
      }
    }

    const userText = String(request.userText || "").trim();
    const assistantText = String(request.assistantText || "").trim();
    if (userText && assistantText) {
      candidates.push(createCandidate({
        summary: buildEpisodicSummary(userText, assistantText),
        canonicalText: `用户输入：${truncate(userText, 280)}\n助手回复：${truncate(assistantText, 320)}`,
        plane: "episodic",
        temporalLevel: "T1",
        type: request.source === "cron" ? "cron_run" : "chat_turn",
        scope: scopes.chat,
        sourceKind: request.source,
        sourceChatId: request.chatId,
        userId: request.userId,
        workspaceId,
        importance: request.source === "cron" ? 0.56 : 0.42,
        confidence: 0.92,
        temperature: "warm",
        metadata: { origin: "heuristic-episodic", botName: request.botName },
        upsertByFamily: false,
      }));
    }

    return dedupeCandidates(candidates);
  }
}
