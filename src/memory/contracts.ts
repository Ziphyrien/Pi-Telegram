// src/memory/contracts.ts — bridge API contracts and shared request/response shapes
import type { MemorySourceKind } from "./types.js";

export interface MemoryBridgeScopePayload {
  chat?: string;
  user?: string;
  workspace?: string;
}

export interface MemoryBridgeSessionPayload {
  sessionId?: string;
  sessionFile?: string;
}

export interface MemoryBridgeContextRequest {
  prompt: string;
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
  source: MemorySourceKind;
  scopes?: MemoryBridgeScopePayload;
  session?: MemoryBridgeSessionPayload;
  budget?: {
    maxTokens?: number;
    maxChars?: number;
  };
}

export interface MemoryBridgeContextResponse {
  contextText: string;
  selectedUris: string[];
  trace: string[] | null;
}

export interface MemoryBridgeMessagePayload {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface MemoryBridgeIngestTurnsRequest {
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
  source: MemorySourceKind;
  scopes?: MemoryBridgeScopePayload;
  session?: MemoryBridgeSessionPayload;
  selectedMemoryUris?: string[];
  messages: MemoryBridgeMessagePayload[];
}

export interface MemoryBridgeIngestTurnsResponse {
  accepted: boolean;
  queued: boolean;
  ingestId: string;
}

export interface MemoryBridgeFlushRequest {
  botHash?: string;
  botName?: string;
  chatId?: number;
  userId?: number;
  workspaceCwd?: string;
  scopes?: MemoryBridgeScopePayload;
  session?: MemoryBridgeSessionPayload;
  reason: "switch" | "shutdown" | "manual";
}

export interface MemoryBridgeFlushResponse {
  ok: boolean;
  flushed: number;
}

export interface MemoryBridgeSearchRequest {
  prompt: string;
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
  source: MemorySourceKind;
  limit?: number;
}

export interface MemoryBridgeSearchResponse {
  nodes: Array<{ canonicalUri: string; familyUri: string; plane: string; temporalLevel: string; summary: string }>;
}

export interface MemoryBridgeTraceRequest {
  canonicalUri: string;
}

export interface MemoryBridgeTraceResponse {
  node?: unknown;
  entities: unknown[];
  edges: unknown[];
}

export interface MemoryBridgeAddRequest {
  text: string;
  summary?: string;
  plane?: "episodic" | "profile" | "project" | "procedural";
  temporalLevel?: "T1" | "T2" | "T3" | "T4" | "T5";
  scopeKind?: "chat-local" | "user-global" | "workspace-global";
  importance?: number;
  confidence?: number;
  source: MemorySourceKind;
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
}

export interface MemoryBridgeAddResponse {
  ok: boolean;
  canonicalUris: string[];
}

export interface MemoryBridgeForgetRequest {
  canonicalUri?: string;
  familyUri?: string;
}

export interface MemoryBridgeForgetResponse {
  ok: boolean;
  deleted: number;
}

export interface MemoryBridgePurgeScopeRequest {
  scopeKind: "chat-local" | "user-global" | "workspace-global" | "system-global";
  scopeId: string;
}

export interface MemoryBridgePurgeScopeResponse {
  ok: boolean;
  deleted: number;
}

export interface MemoryBridgeExportRequest {
  scopeKind?: "chat-local" | "user-global" | "workspace-global" | "system-global";
  scopeId?: string;
}

export interface MemoryBridgeExportResponse {
  nodes: unknown[];
  entities: unknown[];
  edges: unknown[];
  rawTurns: unknown[];
}

export interface MemoryBridgeExportFileRequest extends MemoryBridgeExportRequest {
  filePath?: string;
}

export interface MemoryBridgeExportFileResponse {
  ok: boolean;
  filePath: string;
  nodes: number;
  entities: number;
  edges: number;
  rawTurns: number;
}

export interface MemoryBridgeBackupRequest {
  filePath?: string;
}

export interface MemoryBridgeBackupResponse {
  ok: boolean;
  filePath: string;
}

export interface MemoryBridgeRepairRequest {
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
  source: MemorySourceKind;
  limit?: number;
}

export interface MemoryBridgeRepairResponse {
  ok: boolean;
  scanned: number;
  repaired: number;
}

export interface MemoryBridgeIntegrityResponse {
  ok: boolean;
  checks: string[];
}

export interface MemoryBridgeHealthResponse {
  ok: true;
  service: "pi-memory-core";
  appVersion: string;
  bridgeProtocolVersion: number;
}
