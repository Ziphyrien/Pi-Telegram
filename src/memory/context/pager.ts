// src/memory/context/pager.ts — context residency budgeting and final trimming
import type { MemoryNodeRecord, RawTurnRecord } from "../types.js";

function truncate(input: string, max: number): string {
  const text = String(input || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatNodeLine(node: MemoryNodeRecord): string {
  const label = node.plane === "procedural"
    ? "规则"
    : node.plane === "profile"
      ? "偏好"
      : node.plane === "project"
        ? "项目"
        : "历史";
  return `- [${label}/${node.temporalLevel}] ${node.summary}`;
}

function formatRecentTurn(turn: RawTurnRecord): string {
  const role = turn.role === "user" ? "用户" : "助手";
  return `- ${role}：${truncate(turn.content, 180)}`;
}

function uniqueByFamily(nodes: MemoryNodeRecord[]): MemoryNodeRecord[] {
  const seen = new Set<string>();
  const out: MemoryNodeRecord[] = [];
  for (const node of nodes) {
    const key = node.familyUri || node.canonicalUri;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

function pickPinnedWorkingSet(nodes: MemoryNodeRecord[]): MemoryNodeRecord[] {
  const pinned = nodes.filter((node) =>
    (node.plane === "procedural" && ["T5", "T4"].includes(node.temporalLevel))
    || (node.plane === "profile" && ["T5", "T3"].includes(node.temporalLevel))
    || (node.plane === "project" && ["T5", "T4"].includes(node.temporalLevel))
  );
  return uniqueByFamily(pinned).slice(0, 6);
}

function pickRecallEvidence(nodes: MemoryNodeRecord[], pinned: MemoryNodeRecord[]): MemoryNodeRecord[] {
  const pinnedUris = new Set(pinned.map((node) => node.canonicalUri));
  return uniqueByFamily(nodes.filter((node) => !pinnedUris.has(node.canonicalUri))).slice(0, 8);
}

export class MemoryContextPager {
  compile(maxChars: number, nodes: MemoryNodeRecord[], recentTurns: RawTurnRecord[]): string {
    const pinned = pickPinnedWorkingSet(nodes);
    const evidence = pickRecallEvidence(nodes, pinned);

    const sections: string[] = [];
    const pushSection = (title: string, lines: string[]) => {
      if (!lines.length) return;
      sections.push(`${title}\n${lines.join("\n")}`);
    };

    pushSection("[Pinned Working Set]", pinned.map(formatNodeLine));

    pushSection(
      "[Recall Evidence]",
      evidence.map(formatNodeLine),
    );

    pushSection("[Recent Queue]", recentTurns.map(formatRecentTurn));

    const out: string[] = [];
    let used = 0;
    for (const section of sections) {
      const block = `${section}\n`;
      if (used > 0 && used + block.length > maxChars) break;
      if (used === 0 && block.length > maxChars) {
        out.push(truncate(section, maxChars));
        break;
      }
      out.push(section);
      used += block.length;
    }

    return out.join("\n\n").trim();
  }
}
