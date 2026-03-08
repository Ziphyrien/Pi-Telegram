// src/memory/retrieval/colbert.ts — ColBERT-style late interaction lexical fallback
import type { MemoryNodeRecord } from "../types.js";

function tokenize(input: string): string[] {
  return String(input || "")
    .toLowerCase()
    .match(/[a-z0-9_./:-]{2,}|[\u4e00-\u9fff]{1,}/g) ?? [];
}

function bigrams(token: string): Set<string> {
  const value = String(token || "");
  const out = new Set<string>();
  if (value.length < 2) {
    if (value) out.add(value);
    return out;
  }
  for (let i = 0; i < value.length - 1; i += 1) {
    out.add(value.slice(i, i + 2));
  }
  return out;
}

function tokenSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.85;
  if (a.includes(b) || b.includes(a)) return 0.75;

  const aBi = bigrams(a);
  const bBi = bigrams(b);
  let overlap = 0;
  for (const x of aBi) {
    if (bBi.has(x)) overlap += 1;
  }
  const denom = aBi.size + bBi.size - overlap;
  return denom > 0 ? overlap / denom : 0;
}

export function colbertLateInteractionScore(query: string, node: Pick<MemoryNodeRecord, "summary" | "canonicalText" | "keywords">): number {
  const queryTokens = tokenize(query);
  const docTokens = [...new Set([...tokenize(node.summary), ...tokenize(node.canonicalText), ...node.keywords.map((x) => String(x).toLowerCase())])];
  if (!queryTokens.length || !docTokens.length) return 0;

  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const d of docTokens) {
      const score = tokenSimilarity(q, d);
      if (score > best) best = score;
      if (best >= 1) break;
    }
    total += best;
  }

  return total / queryTokens.length;
}
