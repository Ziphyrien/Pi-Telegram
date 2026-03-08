// src/memory/retrieval/temporal.ts — time-decay and recency helpers
import type { MemoryNodeRecord } from "../types.js";

function halfLifeHours(node: MemoryNodeRecord): number {
  if (node.plane === "procedural") return 24 * 90;
  if (node.plane === "profile") return node.temporalLevel === "T5" ? 24 * 60 : 24 * 21;
  if (node.plane === "project") {
    if (node.temporalLevel === "T5") return 24 * 30;
    if (node.temporalLevel === "T4") return 24 * 14;
    return 24 * 3;
  }
  if (node.temporalLevel === "T2") return 24 * 2;
  return 12;
}

export function timeDecay(node: MemoryNodeRecord, now = Date.now()): number {
  const ageHours = Math.max(0, (now - node.updatedAt) / (1000 * 60 * 60));
  const halfLife = Math.max(1, halfLifeHours(node));
  return Math.exp(-Math.log(2) * ageHours / halfLife);
}

export function decayBoost(node: MemoryNodeRecord, now = Date.now()): number {
  return timeDecay(node, now) * 100;
}
