// src/memory/extraction/llm-extractor.ts — internal pi runner for LLM-based candidate extraction
import { buildCanonicalUri, buildEntityUri, buildFamilyUri, buildWorkspaceId, extractKeywords, resolveScopeSet } from "../scope.js";
import { resolveEntityRefs } from "../entity-resolution/resolver.js";
import { MemoryJsonRunner } from "../llm/json-runner.js";
import type { MemoryCandidate, MemoryEntityRef, MemoryRelationRef, MemoryScopeRef, MemoryScopeSet, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryLlmConfig } from "../../shared/types.js";
import type { MemoryCandidateExtractor } from "../ingest/extractor.js";

function clamp01(input: unknown, fallback: number): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function truncate(input: unknown, max: number): string {
  const text = String(input || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function resolvePlane(value: unknown): MemoryCandidate["plane"] | undefined {
  switch (String(value || "").trim()) {
    case "episodic": return "episodic";
    case "profile": return "profile";
    case "project": return "project";
    case "procedural": return "procedural";
    default:
      return undefined;
  }
}

function resolveTemporalLevel(value: unknown): MemoryCandidate["temporalLevel"] {
  switch (String(value || "").trim()) {
    case "T1": return "T1";
    case "T2": return "T2";
    case "T3": return "T3";
    case "T4": return "T4";
    case "T5": return "T5";
    default:
      return "T1";
  }
}

function defaultScopeForPlane(plane: MemoryCandidate["plane"], scopes: MemoryScopeSet): MemoryScopeRef[] {
  switch (plane) {
    case "procedural":
    case "project":
      return [scopes.workspace];
    case "profile":
      return scopes.user ? [scopes.user] : [scopes.chat];
    case "episodic":
    default:
      return [scopes.chat];
  }
}

function resolveTargetScopes(value: unknown, plane: MemoryCandidate["plane"], scopes: MemoryScopeSet): MemoryScopeRef[] {
  const hints = Array.isArray(value)
    ? value.map((item) => String(item || "").trim())
    : typeof value === "string"
      ? [value.trim()]
      : [];

  if (!hints.length) return defaultScopeForPlane(plane, scopes);

  const out = new Map<string, MemoryScopeRef>();
  for (const hint of hints) {
    if (hint === "chat-local") out.set(scopes.chat.uri, scopes.chat);
    if (hint === "user-global") out.set((scopes.user ?? scopes.chat).uri, scopes.user ?? scopes.chat);
    if (hint === "workspace-global") out.set(scopes.workspace.uri, scopes.workspace);
    if (hint === "both") {
      out.set((scopes.user ?? scopes.chat).uri, scopes.user ?? scopes.chat);
      out.set(scopes.workspace.uri, scopes.workspace);
    }
  }

  return out.size ? [...out.values()] : defaultScopeForPlane(plane, scopes);
}

export function normalizeEntities(value: unknown): MemoryEntityRef[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, MemoryEntityRef>();
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const label = truncate(rec.label ?? rec.name ?? "", 120);
    if (!label) continue;
    const entityType = truncate(rec.entityType ?? rec.type ?? "concept", 48) || "concept";
    const entityUri = typeof rec.entityUri === "string" && rec.entityUri.trim()
      ? rec.entityUri.trim()
      : buildEntityUri(entityType, label);
    const normalized: MemoryEntityRef = {
      entityUri,
      entityType,
      label,
      confidence: clamp01(rec.confidence, 0.72),
    };
    const prev = out.get(entityUri);
    if (!prev || normalized.confidence > prev.confidence) {
      out.set(entityUri, normalized);
    }
  }
  return resolveEntityRefs([...out.values()]);
}

export function normalizeRelations(value: unknown, entities: MemoryEntityRef[]): MemoryRelationRef[] {
  if (!Array.isArray(value)) return [];
  const byLabel = new Map<string, MemoryEntityRef>();
  for (const entity of entities) {
    byLabel.set(entity.label.toLowerCase(), entity);
  }

  const out = new Map<string, MemoryRelationRef>();
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const predicate = truncate(rec.predicate ?? "related_to", 64) || "related_to";
    const subjectLabel = String(rec.subjectLabel ?? rec.subject ?? "").trim().toLowerCase();
    const objectLabel = String(rec.objectLabel ?? rec.object ?? "").trim().toLowerCase();
    const subjectUri = typeof rec.subjectUri === "string" && rec.subjectUri.trim()
      ? rec.subjectUri.trim()
      : byLabel.get(subjectLabel)?.entityUri;
    const objectUri = typeof rec.objectUri === "string" && rec.objectUri.trim()
      ? rec.objectUri.trim()
      : byLabel.get(objectLabel)?.entityUri;
    if (!subjectUri || !objectUri) continue;
    const edgeUri = typeof rec.edgeUri === "string" && rec.edgeUri.trim()
      ? rec.edgeUri.trim()
      : `urn:pi-memory:edge:${predicate}:${Buffer.from(`${subjectUri}|${predicate}|${objectUri}`).toString("base64url")}`;
    const normalized: MemoryRelationRef = {
      edgeUri,
      subjectUri,
      predicate,
      objectUri,
      confidence: clamp01(rec.confidence, 0.7),
    };
    const prev = out.get(edgeUri);
    if (!prev || normalized.confidence > prev.confidence) {
      out.set(edgeUri, normalized);
    }
  }
  return [...out.values()];
}

export function normalizeCandidates(payload: unknown, request: MemoryTurnIngestRequest, scopes: MemoryScopeSet): MemoryCandidate[] {
  const list = asRecord(payload)?.memories;
  if (!Array.isArray(list)) return [];

  const workspaceId = buildWorkspaceId(request.workspaceCwd);
  const out = new Map<string, MemoryCandidate>();

  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const plane = resolvePlane(rec.plane);
    if (!plane) continue;

    const summary = truncate(rec.summary, 180);
    const canonicalText = truncate(rec.canonicalText ?? rec.summary, 700);
    if (!summary || !canonicalText) continue;

    const temporalLevel = resolveTemporalLevel(rec.temporalLevel);
    const entities = normalizeEntities(rec.entities);
    const relations = normalizeRelations(rec.relations, entities);
    const targetScopes = resolveTargetScopes(rec.scopeHint ?? rec.scopeKind, plane, scopes);
    const importance = clamp01(rec.importance, plane === "procedural" ? 0.9 : plane === "profile" ? 0.78 : 0.68);
    const confidence = clamp01(rec.confidence, 0.76);
    const upsertByFamily = typeof rec.upsertByFamily === "boolean"
      ? rec.upsertByFamily
      : plane !== "episodic";

    for (const scope of targetScopes) {
      const familyUri = buildFamilyUri(plane, scope.kind, scope.id, summary);
      const canonicalSeed = upsertByFamily
        ? `${summary}|${temporalLevel}`
        : `${summary}|${canonicalText}|${Date.now()}|${scope.uri}`;
      const candidate: MemoryCandidate = {
        canonicalUri: buildCanonicalUri(plane, scope.kind, scope.id, canonicalSeed),
        familyUri,
        scopeKind: scope.kind,
        scopeId: scope.id,
        scopeUri: scope.uri,
        plane,
        temporalLevel,
        type: truncate(rec.type ?? `${plane}_memory`, 64) || `${plane}_memory`,
        summary,
        canonicalText,
        keywords: extractKeywords(`${summary} ${canonicalText}`, 12),
        importance,
        confidence,
        temperature: plane === "procedural" ? "hot" : plane === "episodic" ? "warm" : "warm",
        sourceKind: request.source,
        sourceChatId: request.chatId,
        userId: request.userId,
        workspaceId,
        eventType: typeof rec.eventType === "string" && rec.eventType.trim() ? truncate(rec.eventType, 64) : undefined,
        entities,
        relations,
        sourceTurnUris: asStringArray(rec.sourceTurnUris),
        metadata: {
          origin: "llm-extractor",
          botName: request.botName,
          scopeHint: rec.scopeHint,
          admissionHint: rec.admissionHint,
          operationHint: rec.operationHint,
        },
        upsertByFamily,
      };
      const key = `${candidate.familyUri}|${candidate.temporalLevel}|${candidate.scopeUri}`;
      const previous = out.get(key);
      if (!previous || candidate.confidence > previous.confidence || candidate.importance > previous.importance) {
        out.set(key, candidate);
      }
    }
  }

  return [...out.values()];
}

export class PiLlmCandidateExtractor implements MemoryCandidateExtractor {
  private readonly runner: MemoryJsonRunner;

  constructor(
    private readonly llm: MemoryLlmConfig,
    private readonly fallback: MemoryCandidateExtractor,
    providerExtensionEntryPath?: string,
  ) {
    this.runner = new MemoryJsonRunner(llm, providerExtensionEntryPath);
  }

  async extractWithLlm(request: MemoryTurnIngestRequest): Promise<MemoryCandidate[] | undefined> {
    const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
    const payload = await this.runner.runJson({
      cwd: request.workspaceCwd,
      purpose: "candidate-extract",
      prompt: [
        "你是 Pi-Telegram 的长期记忆抽取器。只输出严格 JSON，不要 markdown，不要解释。",
        "目标：从一轮 user/assistant 对话中抽取值得长期保留的 memory candidates。",
        "输出格式：{\"memories\":[...]}。",
        "每条 memory 可包含字段：summary, canonicalText, plane, temporalLevel, type, scopeHint, importance, confidence, eventType, sourceTurnUris, admissionHint, operationHint, entities, relations, upsertByFamily。",
        "plane 只能是 episodic/profile/project/procedural。",
        "temporalLevel 只能是 T1/T2/T3/T4/T5。若来自单轮新证据，优先输出 T1。",
        "scopeHint 只能是 chat-local/user-global/workspace-global/both。",
        "对 procedural/correction 保守但高优先级；对 profile 仅在稳定偏好时抽取；对 project 仅在项目约束/背景稳定时抽取。",
        "entities 每项包含：label, entityType, confidence，可选 entityUri。",
        "relations 每项包含：subjectLabel 或 subjectUri, predicate, objectLabel 或 objectUri, confidence。",
        "如果不确定，就少抽，不要编造。",
        `botName: ${request.botName}`,
        `chatId: ${request.chatId}`,
        `userId: ${request.userId ?? "unknown"}`,
        `workspaceId: ${buildWorkspaceId(request.workspaceCwd)}`,
        `availableScopes: ${JSON.stringify({ chat: scopes.chat.uri, user: scopes.user?.uri ?? null, workspace: scopes.workspace.uri })}`,
        `user: ${request.userText}`,
        `assistant: ${request.assistantText}`,
      ].join("\n\n"),
    });

    const candidates = normalizeCandidates(payload, request, scopes);
    return candidates.length ? candidates : undefined;
  }

  extract(request: MemoryTurnIngestRequest, scopes: MemoryScopeSet): MemoryCandidate[] {
    void request;
    void scopes;
    return this.fallback.extract(request, scopes);
  }
}
