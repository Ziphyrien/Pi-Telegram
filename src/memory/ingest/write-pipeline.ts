// src/memory/ingest/write-pipeline.ts — single write path orchestration
import { MemoryAdmissionController, MemoryOperationDecider, type MemoryWriteOperation } from "../active/write-control.js";
import { buildTurnGroupId, buildTurnUri, buildWorkspaceId, resolveScopeSet } from "../scope.js";
import type { MemoryCandidate, MemoryScopeSet, MemoryTurnIngestRequest } from "../types.js";
import type { MemoryStore } from "../store/sqlite-store.js";
import type { MemoryGraphExtractor } from "../graph/extractor.js";
import type { MemoryCandidateExtractor } from "./extractor.js";

export interface MemoryWriteResult {
  canonicalUri: string;
  candidate: MemoryCandidate;
  operation: MemoryWriteOperation;
}

export class MemoryWritePipeline {
  private readonly admission = new MemoryAdmissionController();
  private readonly decider = new MemoryOperationDecider();

  constructor(
    private readonly store: MemoryStore,
    private readonly extractor: MemoryCandidateExtractor,
    private readonly graphExtractor?: MemoryGraphExtractor,
  ) {}

  ingestTurn(request: MemoryTurnIngestRequest): string[] {
    const timestampMs = Number.isFinite(request.timestampMs) ? Number(request.timestampMs) : Date.now();
    const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
    const workspaceId = buildWorkspaceId(request.workspaceCwd);
    const groupId = buildTurnGroupId(request.source, request.botHash, request.chatId, timestampMs);

    this.insertRawTurns(request, scopes, workspaceId, groupId, timestampMs);

    const candidates = this.extractor.extract(request, scopes);
    return this.writeCandidateBatch(request, candidates, timestampMs, scopes).map((item) => item.canonicalUri);
  }

  writeCandidateBatch(
    request: MemoryTurnIngestRequest,
    candidates: MemoryCandidate[],
    timestampMs = Date.now(),
    scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd),
  ): MemoryWriteResult[] {
    const written: MemoryWriteResult[] = [];

    for (const candidate of candidates) {
      if (!this.admission.admit(candidate)) continue;

      const graph = this.graphExtractor?.extract(request, scopes, candidate);
      const enriched: MemoryCandidate = {
        ...candidate,
        eventType: candidate.eventType ?? graph?.eventType,
        entities: candidate.entities?.length ? candidate.entities : graph?.entities,
        relations: candidate.relations?.length ? candidate.relations : graph?.relations,
      };

      const decision = this.decider.decide(enriched);
      if (!decision.admitted || decision.operation === "noop") {
        continue;
      }
      if (decision.operation === "delete") {
        this.store.forgetFamilyUri(enriched.familyUri);
        continue;
      }
      if (decision.operation === "replace") {
        this.store.forgetFamilyUri(enriched.familyUri);
      }

      const canonicalUri = this.store.upsertCandidate({
        ...enriched,
        metadata: {
          ...enriched.metadata,
          operationDecision: decision.operation,
          operationReason: decision.reason,
        },
      }, timestampMs);
      this.store.upsertGraphArtifacts(canonicalUri, enriched.entities, enriched.relations);
      written.push({ canonicalUri, candidate: enriched, operation: decision.operation });
    }

    return written;
  }

  private insertRawTurns(
    request: MemoryTurnIngestRequest,
    scopes: MemoryScopeSet,
    workspaceId: string,
    groupId: string,
    timestampMs: number,
  ): void {
    this.store.insertRawTurn({
      turnUri: buildTurnUri(request.source, "user", request.botHash, request.chatId, timestampMs),
      turnGroupId: groupId,
      scopeKind: scopes.chat.kind,
      scopeId: scopes.chat.id,
      scopeUri: scopes.chat.uri,
      chatId: request.chatId,
      userId: request.userId,
      workspaceId,
      botHash: request.botHash,
      sourceKind: request.source,
      role: "user",
      content: request.userText,
      timestamp: timestampMs,
      metadata: request.metadata,
    });

    this.store.insertRawTurn({
      turnUri: buildTurnUri(request.source, "assistant", request.botHash, request.chatId, timestampMs + 1),
      turnGroupId: groupId,
      scopeKind: scopes.chat.kind,
      scopeId: scopes.chat.id,
      scopeUri: scopes.chat.uri,
      chatId: request.chatId,
      userId: request.userId,
      workspaceId,
      botHash: request.botHash,
      sourceKind: request.source,
      role: "assistant",
      content: request.assistantText,
      timestamp: timestampMs + 1,
      metadata: request.metadata,
    });
  }
}
