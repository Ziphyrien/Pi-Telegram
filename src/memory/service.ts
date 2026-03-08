// src/memory/service.ts — formal memory service facade coordinating store/ingest/retrieval/context
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "../shared/log.js";
import { hasUsableEmbeddingConfig, hasUsableMemoryLlmConfig } from "./config.js";
import { OpenAIEmbeddingClient } from "./embedding/openai-client.js";
import { PiLlmCandidateExtractor } from "./extraction/llm-extractor.js";
import { buildCanonicalUri, buildFamilyUri, buildWorkspaceId, extractKeywords, resolveScopeSet } from "./scope.js";
import { PiLlmGraphExtractor } from "./graph/llm-graph-extractor.js";
import { HeuristicGraphExtractor } from "./graph/heuristic-graph-extractor.js";
import type {
  MemoryBridgeContextRequest,
  MemoryBridgeContextResponse,
  MemoryBridgeFlushRequest,
  MemoryBridgeFlushResponse,
  MemoryBridgeIngestTurnsRequest,
  MemoryBridgeIngestTurnsResponse,
  MemoryBridgeSearchRequest,
  MemoryBridgeSearchResponse,
  MemoryBridgeTraceRequest,
  MemoryBridgeTraceResponse,
  MemoryBridgeAddRequest,
  MemoryBridgeAddResponse,
  MemoryBridgeForgetRequest,
  MemoryBridgeForgetResponse,
  MemoryBridgePurgeScopeRequest,
  MemoryBridgePurgeScopeResponse,
  MemoryBridgeExportRequest,
  MemoryBridgeExportResponse,
  MemoryBridgeExportFileRequest,
  MemoryBridgeExportFileResponse,
  MemoryBridgeBackupRequest,
  MemoryBridgeBackupResponse,
  MemoryBridgeRepairRequest,
  MemoryBridgeRepairResponse,
  MemoryBridgeIntegrityResponse,
} from "./contracts.js";
import { MemoryActiveController } from "./active/controller.js";
import { PiLlmWriteController } from "./active/llm-write-controller.js";
import { PiLlmConsolidator } from "./consolidation/llm-consolidator.js";
import { HeuristicConsolidator } from "./consolidation/heuristic-consolidator.js";
import { MemoryContextAssembler } from "./context/assembler.js";
import { MemoryContextPager } from "./context/pager.js";
import { HeuristicCandidateExtractor } from "./ingest/heuristic-extractor.js";
import { MemoryWritePipeline } from "./ingest/write-pipeline.js";
import { HeuristicRetrievalPlanner } from "./retrieval/heuristic-planner.js";
import { MemoryHybridRetriever } from "./retrieval/hybrid-search.js";
import { PiLlmRetrievalParticipant } from "./retrieval/llm-participant.js";
import { MemoryStore } from "./store/sqlite-store.js";
import type { MemoryCandidate, MemoryPromptContextRequest, MemoryPromptContextResult, MemoryRuntimeConfig, MemoryTurnIngestRequest } from "./types.js";

export class MemoryService {
  private readonly store?: MemoryStore;
  private readonly writePipeline?: MemoryWritePipeline;
  private readonly retriever?: MemoryHybridRetriever;
  private readonly activeController?: MemoryActiveController;
  private readonly llmWriteController?: PiLlmWriteController;
  private readonly consolidator = new HeuristicConsolidator();
  private readonly llmConsolidator?: PiLlmConsolidator;
  private readonly graphExtractor = new HeuristicGraphExtractor();
  private readonly llmGraphExtractor?: PiLlmGraphExtractor;
  private readonly pager = new MemoryContextPager();
  private readonly assembler = new MemoryContextAssembler();
  private readonly embeddingClient?: OpenAIEmbeddingClient;
  private readonly llmExtractor?: PiLlmCandidateExtractor;
  private llmEnabled = false;
  private maintenanceQueue: Promise<void> = Promise.resolve();
  private processedSinceLastFlush = 0;

  constructor(private readonly config: MemoryRuntimeConfig) {
    if (!config.enabled) return;
    mkdirSync(dirname(config.storePath), { recursive: true });
    this.store = new MemoryStore(config.storePath);
    const heuristicExtractor = new HeuristicCandidateExtractor();
    const llmConfig = config.llm;
    const usableLlmConfig = hasUsableMemoryLlmConfig(llmConfig) ? llmConfig : undefined;
    this.llmEnabled = Boolean(usableLlmConfig);
    if (usableLlmConfig) {
      this.llmExtractor = new PiLlmCandidateExtractor(usableLlmConfig, heuristicExtractor, config.providerExtensionEntryPath);
      this.llmWriteController = new PiLlmWriteController(usableLlmConfig, config.providerExtensionEntryPath);
      this.llmConsolidator = new PiLlmConsolidator(usableLlmConfig, config.providerExtensionEntryPath);
      this.llmGraphExtractor = new PiLlmGraphExtractor(usableLlmConfig, config.providerExtensionEntryPath);
    }
    this.writePipeline = new MemoryWritePipeline(this.store, heuristicExtractor, this.graphExtractor);
    const embeddingConfig = config.embedding;
    if (hasUsableEmbeddingConfig(embeddingConfig)) {
      this.embeddingClient = new OpenAIEmbeddingClient(embeddingConfig);
    }
    this.retriever = new MemoryHybridRetriever(
      this.store,
      new HeuristicRetrievalPlanner(),
      this.embeddingClient && embeddingConfig?.model
        ? {
          model: embeddingConfig.model,
          embedQuery: (input: string) => this.embeddingClient!.embed(input),
        }
        : undefined,
      usableLlmConfig ? new PiLlmRetrievalParticipant(usableLlmConfig, config.providerExtensionEntryPath) : undefined,
    );
    this.activeController = new MemoryActiveController(this.retriever);
  }

  get enabled(): boolean {
    return Boolean(this.store && this.writePipeline && this.retriever);
  }

  async preparePrompt(request: MemoryPromptContextRequest, originalPrompt: string): Promise<{ prompt: string; context: MemoryPromptContextResult }> {
    const context = await this.getContext(request);
    return {
      prompt: this.assembler.buildPrompt(context, originalPrompt),
      context,
    };
  }

  async getContext(request: MemoryPromptContextRequest, overrides?: { maxContextChars?: number; maxRecentTurns?: number }): Promise<MemoryPromptContextResult> {
    if (!this.retriever || !this.store || !this.activeController) {
      return { contextText: "", selectedUris: [], traceLines: [] };
    }

    const controlled = await this.activeController.retrieve(request, {
      maxRetrievedMemories: this.config.maxRetrievedMemories,
      maxRecentTurns: overrides?.maxRecentTurns ?? this.config.maxRecentTurns,
    });
    const retrieval = controlled.result;

    const maxContextChars = overrides?.maxContextChars && overrides.maxContextChars > 0
      ? overrides.maxContextChars
      : this.config.maxContextChars;
    const contextText = this.pager.compile(maxContextChars, retrieval.nodes, retrieval.recentTurns);
    const selectedUris = retrieval.nodes.map((x) => x.canonicalUri);
    this.store.markAccessed(selectedUris, Date.now());

    const traceLines = [
      `memory source=${request.source}`,
      `complexity=${retrieval.plan.complexity}`,
      `searchTerms=${retrieval.plan.searchTerms.join(",") || "(none)"}`,
      `clues=${retrieval.plan.clues.join(",") || "(none)"}`,
      `planes=${retrieval.plan.targetPlanes.join(",") || "(none)"}`,
      `levels=${retrieval.plan.targetLevels.join(",") || "(none)"}`,
      `scopes=${retrieval.plan.scopeHints.join(",") || "(none)"}`,
      `selected=${selectedUris.length}`,
      `channels=${retrieval.plan.targetChannels.join("+") || `lexical+entity+graph+temporal+recent${this.embeddingClient ? "+dense" : ""}${this.llmEnabled ? "+llm" : ""}`}`,
      `fusion=RRF+PPR+TimeDecay+ColBERT+RecursiveClustering+MMR+Novelty`,
      `clusterCount=${retrieval.clusterCount}`,
      `novelty=${selectedUris.map((uri) => `${uri}:${retrieval.noveltyByUri.get(uri)?.toFixed(2) ?? "0.00"}`).join("|") || "(none)"}`,
      `controllerMode=${controlled.mode}`,
      `controllerIterations=${controlled.iterations}`,
      retrieval.evidenceGap.length ? `evidenceGap=${retrieval.evidenceGap.join(",")}` : (controlled.evidenceGap ? `evidenceGap=${controlled.evidenceGap}` : "evidenceGap=none"),
    ];

    if (this.config.trace && selectedUris.length) {
      log.boot(`memory selected=${selectedUris.length} chat=${request.chatId}`);
    }

    return {
      contextText,
      selectedUris,
      traceLines,
    };
  }

  ingestTurn(request: MemoryTurnIngestRequest): void {
    const writtenUris = this.writePipeline?.ingestTurn(request) ?? [];
    if (writtenUris.length) {
      this.scheduleMaintenance(writtenUris, request);
    }
  }

  private scheduleMaintenance(canonicalUris: string[], request: MemoryTurnIngestRequest): void {
    if (!this.store || !this.writePipeline) return;
    const store = this.store;
    const writePipeline = this.writePipeline;

    this.maintenanceQueue = this.maintenanceQueue
      .catch(() => {})
      .then(async () => {
        const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
        const allWrittenUris = new Set<string>(canonicalUris);
        const baseNodes = canonicalUris
          .map((uri) => store.getNode(uri))
          .filter((node): node is NonNullable<typeof node> => Boolean(node));
        let consolidationSeeds = [...baseNodes];

        if (this.llmExtractor) {
          try {
            const llmCandidates = await this.llmExtractor.extractWithLlm(request);
            if (llmCandidates?.length) {
              const controlledCandidates = await this.llmWriteController?.decide(request, llmCandidates) ?? llmCandidates;
              const llmWrites = writePipeline.writeCandidateBatch(request, controlledCandidates, Date.now());
              for (const write of llmWrites) {
                allWrittenUris.add(write.canonicalUri);
              }
              const llmNodes = llmWrites
                .map((write) => store.getNode(write.canonicalUri))
                .filter((node): node is NonNullable<typeof node> => Boolean(node));
              consolidationSeeds = [...consolidationSeeds, ...llmNodes];
              this.processedSinceLastFlush += llmWrites.length;
            }
          } catch (err) {
            log.warn(`memory llm maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (this.llmGraphExtractor) {
          for (const canonicalUri of allWrittenUris) {
            const node = store.getNode(canonicalUri);
            if (!node) continue;
            try {
              const graph = await this.llmGraphExtractor.extractFromNode(request, scopes, node);
              if (graph) {
                if (graph.eventType) {
                  store.setNodeEventType(canonicalUri, graph.eventType);
                }
                if (graph.entities.length || graph.relations.length) {
                  store.upsertGraphArtifacts(canonicalUri, graph.entities, graph.relations);
                }
                store.patchNodeMetadata(canonicalUri, { graphStatus: "ready", graphOrigin: "llm" });
                this.processedSinceLastFlush += 1;
              }
            } catch (err) {
              store.patchNodeMetadata(canonicalUri, {
                graphStatus: "failed",
                graphOrigin: "llm",
                lastGraphError: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const t1Seeds = consolidationSeeds.filter((node) => node.temporalLevel === "T1");
        const consolidated = await this.llmConsolidator?.consolidate(request, t1Seeds)
          ?? this.consolidator.consolidate(t1Seeds);
        const consolidatedWrites = writePipeline.writeCandidateBatch(request, consolidated, Date.now());
        for (const write of consolidatedWrites) {
          allWrittenUris.add(write.canonicalUri);
          if (write.candidate.metadata && typeof write.candidate.metadata.derivedFrom === "string") {
            store.upsertGraphArtifacts(write.canonicalUri, [], [
              {
                edgeUri: `${write.canonicalUri}:summarizes`,
                subjectUri: write.canonicalUri,
                predicate: "summarizes",
                objectUri: String(write.candidate.metadata.derivedFrom),
                confidence: write.candidate.confidence,
              },
            ]);
          }
        }
        this.processedSinceLastFlush += consolidatedWrites.length;

        if (this.embeddingClient && this.config.embedding?.model) {
          for (const canonicalUri of allWrittenUris) {
            const node = store.getNode(canonicalUri);
            if (!node) continue;
            try {
              const vector = await this.embeddingClient.embed(`${node.summary}\n\n${node.canonicalText}`);
              store.upsertEmbedding(node.canonicalUri, this.config.embedding.model, vector, Date.now());
              store.patchNodeMetadata(node.canonicalUri, {
                embeddingStatus: "ready",
                embeddingModel: this.config.embedding.model,
              });
              this.processedSinceLastFlush += 1;
            } catch (err) {
              store.patchNodeMetadata(node.canonicalUri, {
                embeddingStatus: "missing",
                embeddingModel: this.config.embedding.model,
                lastEmbeddingError: err instanceof Error ? err.message : String(err),
              });
              log.warn(`memory embedding failed for ${node.canonicalUri}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      });
  }

  getStats(): { enabled: boolean; memoryNodes: number; rawTurns: number } {
    if (!this.store) {
      return { enabled: false, memoryNodes: 0, rawTurns: 0 };
    }
    return { enabled: true, ...this.store.getStats() };
  }

  async flush(_reason?: string): Promise<number> {
    await this.maintenanceQueue.catch(() => {});
    const flushed = this.processedSinceLastFlush;
    this.processedSinceLastFlush = 0;
    return flushed;
  }

  async handleBridgeContext(request: MemoryBridgeContextRequest): Promise<MemoryBridgeContextResponse> {
    const context = await this.getContext({
      botHash: request.botHash,
      botName: request.botName,
      chatId: request.chatId,
      userId: request.userId,
      workspaceCwd: request.workspaceCwd,
      prompt: request.prompt,
      source: request.source,
    }, {
      maxContextChars: request.budget?.maxChars,
    });

    return {
      contextText: context.contextText,
      selectedUris: context.selectedUris,
      trace: this.config.trace ? context.traceLines : null,
    };
  }

  handleBridgeIngestTurns(request: MemoryBridgeIngestTurnsRequest): MemoryBridgeIngestTurnsResponse {
    const userText = request.messages
      .filter((x) => x.role === "user")
      .map((x) => x.content)
      .join("\n\n")
      .trim();
    const assistantText = request.messages
      .filter((x) => x.role === "assistant")
      .map((x) => x.content)
      .join("\n\n")
      .trim();

    if (userText || assistantText) {
      this.ingestTurn({
        botHash: request.botHash,
        botName: request.botName,
        chatId: request.chatId,
        userId: request.userId,
        workspaceCwd: request.workspaceCwd,
        userText,
        assistantText,
        source: request.source,
        timestampMs: request.messages[0]?.timestamp,
        metadata: request.selectedMemoryUris?.length
          ? { selectedMemoryUris: request.selectedMemoryUris, session: request.session }
          : { session: request.session },
      });
    }

    return {
      accepted: true,
      queued: false,
      ingestId: `ingest-${Date.now()}`,
    };
  }

  async search(request: MemoryBridgeSearchRequest): Promise<MemoryBridgeSearchResponse> {
    if (!this.activeController) {
      return { nodes: [] };
    }
    const controlled = await this.activeController.retrieve({
      botHash: request.botHash,
      botName: request.botName,
      chatId: request.chatId,
      userId: request.userId,
      workspaceCwd: request.workspaceCwd,
      prompt: request.prompt,
      source: request.source,
    }, {
      maxRetrievedMemories: request.limit ?? this.config.maxRetrievedMemories,
      maxRecentTurns: this.config.maxRecentTurns,
    });
    return {
      nodes: controlled.result.nodes.map((node) => ({
        canonicalUri: node.canonicalUri,
        familyUri: node.familyUri,
        plane: node.plane,
        temporalLevel: node.temporalLevel,
        summary: node.summary,
      })),
    };
  }

  add(request: MemoryBridgeAddRequest): MemoryBridgeAddResponse {
    if (!this.writePipeline) {
      return { ok: true, canonicalUris: [] };
    }

    const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
    const workspaceId = buildWorkspaceId(request.workspaceCwd);
    const scope = request.scopeKind === "user-global"
      ? (scopes.user ?? scopes.chat)
      : request.scopeKind === "workspace-global"
        ? scopes.workspace
        : scopes.chat;
    const plane = request.plane ?? (request.scopeKind === "workspace-global" ? "project" : "episodic");
    const temporalLevel = request.temporalLevel ?? (plane === "procedural" ? "T5" : "T1");
    const text = String(request.text || "").trim();
    const summary = String(request.summary || text).trim() || text;

    if (!text || !summary) {
      return { ok: true, canonicalUris: [] };
    }

    const candidate: MemoryCandidate = {
      canonicalUri: buildCanonicalUri(plane, scope.kind, scope.id, `${summary}|${temporalLevel}`),
      familyUri: buildFamilyUri(plane, scope.kind, scope.id, summary),
      scopeKind: scope.kind,
      scopeId: scope.id,
      scopeUri: scope.uri,
      plane,
      temporalLevel,
      type: plane === "procedural" ? "manual_rule" : plane === "profile" ? "manual_preference" : plane === "project" ? "manual_project_memory" : "manual_memory",
      summary,
      canonicalText: text,
      keywords: extractKeywords(`${summary} ${text}`, 12),
      importance: Math.max(0, Math.min(1, Number(request.importance ?? (plane === "procedural" ? 0.95 : 0.75)))),
      confidence: Math.max(0, Math.min(1, Number(request.confidence ?? 0.95))),
      temperature: plane === "procedural" ? "hot" : "warm",
      sourceKind: request.source,
      sourceChatId: request.chatId,
      userId: request.userId,
      workspaceId,
      metadata: {
        origin: "manual-add",
        botName: request.botName,
        operationHint: "add",
      },
      upsertByFamily: plane !== "episodic",
    };

    const written = this.writePipeline.writeCandidateBatch({
      botHash: request.botHash,
      botName: request.botName,
      chatId: request.chatId,
      userId: request.userId,
      workspaceCwd: request.workspaceCwd,
      userText: "",
      assistantText: "",
      source: request.source,
      timestampMs: Date.now(),
      metadata: { manual: true },
    }, [candidate], Date.now(), scopes);

    this.processedSinceLastFlush += written.length;
    if (written.length) {
      this.scheduleMaintenance(written.map((item) => item.canonicalUri), {
        botHash: request.botHash,
        botName: request.botName,
        chatId: request.chatId,
        userId: request.userId,
        workspaceCwd: request.workspaceCwd,
        userText: text,
        assistantText: "",
        source: request.source,
        timestampMs: Date.now(),
        metadata: { manual: true },
      });
    }

    return { ok: true, canonicalUris: written.map((item) => item.canonicalUri) };
  }

  trace(request: MemoryBridgeTraceRequest): MemoryBridgeTraceResponse {
    const node = this.store?.getNode(request.canonicalUri);
    return {
      node,
      entities: this.store?.getEntities(request.canonicalUri) ?? [],
      edges: this.store?.getEdges(request.canonicalUri) ?? [],
    };
  }

  forget(request: MemoryBridgeForgetRequest): MemoryBridgeForgetResponse {
    if (!this.store) {
      return { ok: true, deleted: 0 };
    }
    const deleted = request.canonicalUri
      ? this.store.forgetCanonicalUri(request.canonicalUri)
      : request.familyUri
        ? this.store.forgetFamilyUri(request.familyUri)
        : 0;
    return {
      ok: true,
      deleted,
    };
  }

  purgeScope(request: MemoryBridgePurgeScopeRequest): MemoryBridgePurgeScopeResponse {
    if (!this.store) {
      return { ok: true, deleted: 0 };
    }
    return {
      ok: true,
      deleted: this.store.purgeScope(request.scopeKind, request.scopeId),
    };
  }

  exportSnapshot(request: MemoryBridgeExportRequest): MemoryBridgeExportResponse {
    if (!this.store) {
      return { nodes: [], entities: [], edges: [], rawTurns: [] };
    }
    return this.store.exportSnapshot(request.scopeKind && request.scopeId
      ? { scopeKind: request.scopeKind, scopeId: request.scopeId }
      : undefined);
  }

  private buildOpsFilePath(kind: "exports" | "backups", extension: string): string {
    const root = resolve(dirname(this.config.storePath), kind);
    mkdirSync(root, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return resolve(root, `memory-${kind}-${timestamp}.${extension}`);
  }

  exportToFile(request: MemoryBridgeExportFileRequest): MemoryBridgeExportFileResponse {
    if (!this.store) {
      return { ok: true, filePath: request.filePath || "", nodes: 0, entities: 0, edges: 0, rawTurns: 0 };
    }
    const filePath = request.filePath?.trim() || this.buildOpsFilePath("exports", "json");
    const result = this.store.exportSnapshotToFile(
      filePath,
      request.scopeKind && request.scopeId ? { scopeKind: request.scopeKind, scopeId: request.scopeId } : undefined,
    );
    return {
      ok: true,
      ...result,
    };
  }

  async backup(request: MemoryBridgeBackupRequest): Promise<MemoryBridgeBackupResponse> {
    if (!this.store) {
      return { ok: true, filePath: request.filePath || "" };
    }
    await this.flush("manual");
    const filePath = request.filePath?.trim() || this.buildOpsFilePath("backups", "sqlite");
    this.store.backupTo(filePath);
    return {
      ok: true,
      filePath,
    };
  }

  async repairArtifacts(request: MemoryBridgeRepairRequest): Promise<MemoryBridgeRepairResponse> {
    if (!this.store) {
      return { ok: true, scanned: 0, repaired: 0 };
    }

    const scopes = resolveScopeSet(request.botHash, request.chatId, request.userId, request.workspaceCwd);
    const nodes = this.store.listNodesNeedingRepair(scopes, Math.max(1, request.limit ?? 20));
    const repairRequest: MemoryTurnIngestRequest = {
      botHash: request.botHash,
      botName: request.botName,
      chatId: request.chatId,
      userId: request.userId,
      workspaceCwd: request.workspaceCwd,
      userText: "",
      assistantText: "",
      source: request.source,
      timestampMs: Date.now(),
      metadata: { repair: true },
    };

    let repaired = 0;
    for (const node of nodes) {
      const metadata = node.metadata ?? {};
      if (this.llmGraphExtractor && metadata.graphStatus === "failed") {
        try {
          const graph = await this.llmGraphExtractor.extractFromNode(repairRequest, scopes, node);
          if (graph) {
            if (graph.eventType) this.store.setNodeEventType(node.canonicalUri, graph.eventType);
            if (graph.entities.length || graph.relations.length) {
              this.store.upsertGraphArtifacts(node.canonicalUri, graph.entities, graph.relations);
            }
            this.store.patchNodeMetadata(node.canonicalUri, { graphStatus: "ready", graphOrigin: "llm-repair", lastGraphError: null });
            repaired += 1;
          }
        } catch (err) {
          this.store.patchNodeMetadata(node.canonicalUri, { lastGraphError: err instanceof Error ? err.message : String(err) });
        }
      }

      if (this.embeddingClient && this.config.embedding?.model && metadata.embeddingStatus === "missing") {
        try {
          const vector = await this.embeddingClient.embed(`${node.summary}\n\n${node.canonicalText}`);
          this.store.upsertEmbedding(node.canonicalUri, this.config.embedding.model, vector, Date.now());
          this.store.patchNodeMetadata(node.canonicalUri, { embeddingStatus: "ready", embeddingModel: this.config.embedding.model, lastEmbeddingError: null });
          repaired += 1;
        } catch (err) {
          this.store.patchNodeMetadata(node.canonicalUri, { lastEmbeddingError: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return {
      ok: true,
      scanned: nodes.length,
      repaired,
    };
  }

  integrity(): MemoryBridgeIntegrityResponse {
    if (!this.store) {
      return { ok: true, checks: ["ok"] };
    }
    const checks = this.store.integrityCheck();
    return {
      ok: checks.every((line) => String(line).toLowerCase() === "ok"),
      checks,
    };
  }

  async handleBridgeSearch(request: MemoryBridgeSearchRequest): Promise<MemoryBridgeSearchResponse> {
    return this.search(request);
  }

  handleBridgeTrace(request: MemoryBridgeTraceRequest): MemoryBridgeTraceResponse {
    return this.trace(request);
  }

  handleBridgeForget(request: MemoryBridgeForgetRequest): MemoryBridgeForgetResponse {
    return this.forget(request);
  }

  handleBridgePurgeScope(request: MemoryBridgePurgeScopeRequest): MemoryBridgePurgeScopeResponse {
    return this.purgeScope(request);
  }

  handleBridgeExport(request: MemoryBridgeExportRequest): MemoryBridgeExportResponse {
    return this.exportSnapshot(request);
  }

  handleBridgeExportFile(request: MemoryBridgeExportFileRequest): MemoryBridgeExportFileResponse {
    return this.exportToFile(request);
  }

  async handleBridgeBackup(request: MemoryBridgeBackupRequest): Promise<MemoryBridgeBackupResponse> {
    return await this.backup(request);
  }

  async handleBridgeRepair(request: MemoryBridgeRepairRequest): Promise<MemoryBridgeRepairResponse> {
    return await this.repairArtifacts(request);
  }

  handleBridgeIntegrity(): MemoryBridgeIntegrityResponse {
    return this.integrity();
  }

  async handleBridgeFlush(request: MemoryBridgeFlushRequest): Promise<MemoryBridgeFlushResponse> {
    return {
      ok: true,
      flushed: await this.flush(request.reason),
    };
  }

  shutdown(): void {
    this.store?.shutdown();
  }
}

export function createMemoryService(config: MemoryRuntimeConfig): MemoryService {
  return new MemoryService(config);
}
