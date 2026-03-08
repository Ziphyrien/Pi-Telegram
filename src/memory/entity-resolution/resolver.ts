// src/memory/entity-resolution/resolver.ts — entity normalization and resolution helpers
import { createHash } from "node:crypto";
import type { MemoryEntityRef } from "../types.js";

const ALIAS_MAP = new Map<string, string>([
  ["pi telegram", "Pi-Telegram"],
  ["pi-telegram", "Pi-Telegram"],
  ["pitg", "Pi-Telegram"],
  ["tg", "Telegram"],
  ["telegram bot", "Telegram"],
  ["spec first", "spec-first"],
]);

function shortHash(input: string, length = 20): string {
  return createHash("sha1").update(input).digest("hex").slice(0, length);
}

export function normalizeEntityLabel(label: string): string {
  const normalized = String(label || "")
    .normalize("NFKC")
    .replace(/[_-]+/g, " ")
    .replace(/[\\/]+/g, " ")
    .replace(/[()\[\]{}.,;:!?"'`~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return ALIAS_MAP.get(normalized) ?? normalized;
}

export function buildResolvedEntityUri(entityType: string, label: string): string {
  const key = shortHash(`${entityType}|${normalizeEntityLabel(label)}`);
  return `urn:pi-memory:entity:${entityType}:${key}`;
}

export function resolveEntityRef(entity: MemoryEntityRef): MemoryEntityRef {
  const normalizedLabel = normalizeEntityLabel(entity.label);
  const displayLabel = ALIAS_MAP.get(normalizedLabel) ?? (entity.label.trim() || normalizedLabel);
  return {
    entityUri: buildResolvedEntityUri(entity.entityType, displayLabel),
    entityType: entity.entityType,
    label: displayLabel,
    confidence: entity.confidence,
  };
}

export function resolveEntityRefs(entities: MemoryEntityRef[]): MemoryEntityRef[] {
  const out = new Map<string, MemoryEntityRef>();
  for (const entity of entities) {
    const resolved = resolveEntityRef(entity);
    const previous = out.get(resolved.entityUri);
    if (!previous || resolved.confidence > previous.confidence) {
      out.set(resolved.entityUri, resolved);
    }
  }
  return [...out.values()];
}
