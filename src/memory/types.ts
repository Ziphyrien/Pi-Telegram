// src/memory/types.ts — internal memory core types

export type MemoryPlane = "episodic" | "profile" | "project" | "procedural";
export type MemoryScopeKind = "chat-local" | "user-global" | "workspace-global" | "system-global";
export type MemoryTemporalLevel = "T1" | "T2" | "T3" | "T4" | "T5";
export type MemoryTemperature = "hot" | "warm" | "cold";
export type MemorySourceKind = "telegram" | "cron";

export interface MemoryRuntimeConfig {
  enabled: boolean;
  storePath: string;
  maxContextChars: number;
  maxRetrievedMemories: number;
  maxRecentTurns: number;
  trace: boolean;
  providerExtensionEntryPath?: string;
  llm?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    api?: string;
    authHeader?: boolean;
  };
  embedding?: {
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
  };
}

export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
  uri: string;
  label: string;
}

export interface MemoryScopeSet {
  chat: MemoryScopeRef;
  user?: MemoryScopeRef;
  workspace: MemoryScopeRef;
}

export interface MemoryPromptContextRequest {
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
  prompt: string;
  source: MemorySourceKind;
}

export interface MemoryPromptContextResult {
  contextText: string;
  selectedUris: string[];
  traceLines: string[];
}

export interface MemoryTurnIngestRequest {
  botHash: string;
  botName: string;
  chatId: number;
  userId?: number;
  workspaceCwd: string;
  userText: string;
  assistantText: string;
  source: MemorySourceKind;
  timestampMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntityRef {
  entityUri: string;
  entityType: string;
  label: string;
  confidence: number;
}

export interface MemoryRelationRef {
  edgeUri: string;
  subjectUri: string;
  predicate: string;
  objectUri: string;
  confidence: number;
}

export interface MemoryCandidate {
  canonicalUri: string;
  familyUri: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  scopeUri: string;
  plane: MemoryPlane;
  temporalLevel: MemoryTemporalLevel;
  type: string;
  summary: string;
  canonicalText: string;
  keywords: string[];
  importance: number;
  confidence: number;
  temperature: MemoryTemperature;
  sourceKind: MemorySourceKind;
  sourceChatId: number;
  userId?: number;
  workspaceId: string;
  eventType?: string;
  entities?: MemoryEntityRef[];
  relations?: MemoryRelationRef[];
  sourceTurnUris?: string[];
  metadata?: Record<string, unknown>;
  upsertByFamily: boolean;
}

export interface MemoryNodeRecord {
  canonicalUri: string;
  familyUri: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  scopeUri: string;
  plane: MemoryPlane;
  temporalLevel: MemoryTemporalLevel;
  type: string;
  summary: string;
  canonicalText: string;
  keywords: string[];
  importance: number;
  confidence: number;
  temperature: MemoryTemperature;
  sourceKind: MemorySourceKind;
  sourceChatId: number;
  userId?: number;
  workspaceId: string;
  eventType?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  metadata?: Record<string, unknown>;
}

export interface RawTurnRecord {
  turnUri: string;
  turnGroupId: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  scopeUri: string;
  chatId: number;
  userId?: number;
  workspaceId: string;
  botHash: string;
  sourceKind: MemorySourceKind;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  nodes: MemoryNodeRecord[];
  recentTurns: RawTurnRecord[];
}

export interface MemoryEmbeddingRecord {
  canonicalUri: string;
  model: string;
  vector: number[];
}
