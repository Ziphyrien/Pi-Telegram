// src/memory/telegram-client.ts — Telegram-side memory adapter with transport separation
import type { MemoryService } from "./service.js";
import type { MemorySourceKind } from "./types.js";

export interface TelegramMemoryClient {
  enabled: boolean;
  transport: "direct" | "bridge" | "disabled";
  preparePrompt(args: {
    chatId: number;
    userId?: number;
    promptText: string;
    originalPrompt: string;
    source: MemorySourceKind;
  }): Promise<{ prompt: string; selectedUris: string[] }>;
  ingestTurn(args: {
    chatId: number;
    userId?: number;
    userText: string;
    assistantText: string;
    source: MemorySourceKind;
    selectedMemoryUris?: string[];
  }): void;
  add(args: {
    chatId: number;
    userId?: number;
    text: string;
    summary?: string;
    plane?: "episodic" | "profile" | "project" | "procedural";
    temporalLevel?: "T1" | "T2" | "T3" | "T4" | "T5";
    scopeKind?: "chat-local" | "user-global" | "workspace-global";
    importance?: number;
    confidence?: number;
    source: MemorySourceKind;
  }): Promise<{ ok: boolean; canonicalUris: string[] }>;
  search(args: {
    chatId: number;
    userId?: number;
    promptText: string;
    source: MemorySourceKind;
    limit?: number;
  }): Promise<{ nodes: Array<{ canonicalUri: string; familyUri: string; plane: string; temporalLevel: string; summary: string }> }>;
  trace(args: { canonicalUri: string }): Promise<{ node?: unknown; entities: unknown[]; edges: unknown[] }>;
  forget(args: { canonicalUri?: string; familyUri?: string }): Promise<{ ok: boolean; deleted: number }>;
  purgeScope(args: { scopeKind: "chat-local" | "user-global" | "workspace-global" | "system-global"; scopeId: string }): Promise<{ ok: boolean; deleted: number }>;
  exportSnapshot(args?: { scopeKind?: "chat-local" | "user-global" | "workspace-global" | "system-global"; scopeId?: string }): Promise<{ nodes: unknown[]; entities: unknown[]; edges: unknown[]; rawTurns: unknown[] }>;
  exportToFile(args?: { scopeKind?: "chat-local" | "user-global" | "workspace-global" | "system-global"; scopeId?: string; filePath?: string }): Promise<{ ok: boolean; filePath: string; nodes: number; entities: number; edges: number; rawTurns: number }>;
  backup(args?: { filePath?: string }): Promise<{ ok: boolean; filePath: string }>;
  repair(args: { chatId: number; userId?: number; source: MemorySourceKind; limit?: number }): Promise<{ ok: boolean; scanned: number; repaired: number }>;
  integrity(): Promise<{ ok: boolean; checks: string[] }>;
  flush(reason?: string): Promise<number>;
  getStats(): { enabled: boolean; memoryNodes: number; rawTurns: number };
}

export interface CreateTelegramMemoryClientOptions {
  service?: MemoryService | null;
  transport?: "direct" | "bridge" | "disabled";
  botHash: string;
  botName: string;
  workspaceCwd: string;
}

export function createTelegramMemoryClient(opts: CreateTelegramMemoryClientOptions): TelegramMemoryClient {
  const transport = opts.transport ?? (opts.service?.enabled ? "direct" : "disabled");
  const service = opts.service && opts.service.enabled ? opts.service : null;

  return {
    enabled: Boolean(service),
    transport,
    async preparePrompt(args) {
      if (!service || transport !== "direct") {
        return { prompt: args.originalPrompt, selectedUris: [] };
      }
      const prepared = await service.preparePrompt({
        botHash: opts.botHash,
        botName: opts.botName,
        chatId: args.chatId,
        userId: args.userId,
        workspaceCwd: opts.workspaceCwd,
        prompt: args.promptText,
        source: args.source,
      }, args.originalPrompt);
      return {
        prompt: prepared.prompt,
        selectedUris: prepared.context.selectedUris,
      };
    },
    ingestTurn(args) {
      if (!service || transport !== "direct") return;
      if (!String(args.userText || "").trim() || !String(args.assistantText || "").trim()) return;
      service.ingestTurn({
        botHash: opts.botHash,
        botName: opts.botName,
        chatId: args.chatId,
        userId: args.userId,
        workspaceCwd: opts.workspaceCwd,
        userText: args.userText,
        assistantText: args.assistantText,
        source: args.source,
        timestampMs: Date.now(),
        metadata: args.selectedMemoryUris?.length ? { selectedMemoryUris: args.selectedMemoryUris } : undefined,
      });
    },
    async add(args) {
      if (!service) return { ok: true, canonicalUris: [] };
      return service.add({
        botHash: opts.botHash,
        botName: opts.botName,
        chatId: args.chatId,
        userId: args.userId,
        workspaceCwd: opts.workspaceCwd,
        text: args.text,
        summary: args.summary,
        plane: args.plane,
        temporalLevel: args.temporalLevel,
        scopeKind: args.scopeKind,
        importance: args.importance,
        confidence: args.confidence,
        source: args.source,
      });
    },
    async search(args) {
      if (!service) return { nodes: [] };
      return service.search({
        botHash: opts.botHash,
        botName: opts.botName,
        chatId: args.chatId,
        userId: args.userId,
        workspaceCwd: opts.workspaceCwd,
        prompt: args.promptText,
        source: args.source,
        limit: args.limit,
      });
    },
    async trace(args) {
      if (!service) return { node: undefined, entities: [], edges: [] };
      return service.trace({ canonicalUri: args.canonicalUri });
    },
    async forget(args) {
      if (!service) return { ok: true, deleted: 0 };
      return service.forget(args);
    },
    async purgeScope(args) {
      if (!service) return { ok: true, deleted: 0 };
      return service.purgeScope(args);
    },
    async exportSnapshot(args) {
      if (!service) return { nodes: [], entities: [], edges: [], rawTurns: [] };
      return service.exportSnapshot(args ?? {});
    },
    async exportToFile(args) {
      if (!service) return { ok: true, filePath: args?.filePath || "", nodes: 0, entities: 0, edges: 0, rawTurns: 0 };
      return service.exportToFile(args ?? {});
    },
    async backup(args) {
      if (!service) return { ok: true, filePath: args?.filePath || "" };
      return await service.backup(args ?? {});
    },
    async repair(args) {
      if (!service) return { ok: true, scanned: 0, repaired: 0 };
      return await service.repairArtifacts({
        botHash: opts.botHash,
        botName: opts.botName,
        chatId: args.chatId,
        userId: args.userId,
        workspaceCwd: opts.workspaceCwd,
        source: args.source,
        limit: args.limit,
      });
    },
    async integrity() {
      if (!service) return { ok: true, checks: ["ok"] };
      return service.integrity();
    },
    async flush(reason) {
      if (!service || transport !== "direct") return 0;
      return await service.flush(reason);
    },
    getStats() {
      return service?.getStats() ?? { enabled: false, memoryNodes: 0, rawTurns: 0 };
    },
  };
}
