// src/memory/scope.ts — scope and URI helpers
import { createHash, randomUUID } from "node:crypto";
import { buildResolvedEntityUri } from "./entity-resolution/resolver.js";
import type { MemoryPlane, MemoryScopeKind, MemoryScopeRef, MemoryScopeSet, MemorySourceKind } from "./types.js";

function shortHash(input: string, length = 12): string {
  return createHash("sha1").update(input).digest("hex").slice(0, length);
}

export function normalizeTextForKey(input: string): string {
  return String(input || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildWorkspaceId(workspaceCwd: string): string {
  const normalized = String(workspaceCwd || "").trim() || "workspace:default";
  return `repo.${shortHash(normalized, 10)}`;
}

export function buildChatScope(botHash: string, chatId: number): MemoryScopeRef {
  const id = `${botHash}:${chatId}`;
  return {
    kind: "chat-local",
    id,
    uri: `urn:pi-memory:scope:chat:telegram:${botHash}:${chatId}`,
    label: `chat:${chatId}`,
  };
}

export function buildUserScope(userId?: number): MemoryScopeRef | undefined {
  if (!Number.isSafeInteger(userId) || !userId) return undefined;
  return {
    kind: "user-global",
    id: String(userId),
    uri: `urn:pi-memory:scope:user:telegram:${userId}`,
    label: `user:${userId}`,
  };
}

export function buildWorkspaceScope(workspaceCwd: string): MemoryScopeRef {
  const workspaceId = buildWorkspaceId(workspaceCwd);
  return {
    kind: "workspace-global",
    id: workspaceId,
    uri: `urn:pi-memory:scope:workspace:${workspaceId}`,
    label: `workspace:${workspaceId}`,
  };
}

export function resolveScopeSet(botHash: string, chatId: number, userId: number | undefined, workspaceCwd: string): MemoryScopeSet {
  return {
    chat: buildChatScope(botHash, chatId),
    user: buildUserScope(userId),
    workspace: buildWorkspaceScope(workspaceCwd),
  };
}

export function buildFamilyUri(plane: MemoryPlane, scopeKind: MemoryScopeKind, scopeId: string, text: string): string {
  const familyKey = shortHash(`${plane}|${scopeKind}|${scopeId}|${normalizeTextForKey(text)}`, 16);
  return `urn:pi-memory:family:${plane}:${scopeKind}:${scopeId}:${familyKey}`;
}

export function buildCanonicalUri(plane: MemoryPlane, scopeKind: MemoryScopeKind, scopeId: string, text: string): string {
  const nodeKey = shortHash(`${plane}|${scopeKind}|${scopeId}|${normalizeTextForKey(text)}`, 20);
  return `urn:pi-memory:node:${plane}:${scopeKind}:${scopeId}:${nodeKey}`;
}

export function buildTurnGroupId(source: MemorySourceKind, botHash: string, chatId: number, timestampMs: number): string {
  const key = shortHash(`${source}|${botHash}|${chatId}|${timestampMs}|${randomUUID()}`, 18);
  return `urn:pi-memory:turn-group:${source}:${botHash}:${chatId}:${key}`;
}

export function buildTurnUri(source: MemorySourceKind, role: "user" | "assistant", botHash: string, chatId: number, timestampMs: number): string {
  const key = shortHash(`${source}|${role}|${botHash}|${chatId}|${timestampMs}|${randomUUID()}`, 18);
  return `urn:pi-memory:turn:${source}:${role}:${botHash}:${chatId}:${key}`;
}

export function buildEntityUri(entityType: string, label: string): string {
  return buildResolvedEntityUri(entityType, label);
}

export function buildEdgeUri(subjectUri: string, predicate: string, objectUri: string): string {
  const key = shortHash(`${subjectUri}|${predicate}|${objectUri}`, 20);
  return `urn:pi-memory:edge:${predicate}:${key}`;
}

export function extractKeywords(input: string, maxKeywords = 8): string[] {
  const ascii = String(input || "").toLowerCase().match(/[a-z0-9][a-z0-9_./:-]{1,}/g) ?? [];
  const chinese = String(input || "").match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const token of [...ascii, ...chinese]) {
    const key = token.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token.trim());
    if (out.length >= maxKeywords) break;
  }

  return out;
}
