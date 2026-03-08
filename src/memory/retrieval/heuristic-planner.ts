// src/memory/retrieval/heuristic-planner.ts — deterministic fallback planner
import type { MemoryPlane, MemoryPromptContextRequest, MemoryScopeKind, MemoryTemporalLevel } from "../types.js";
import type { MemoryRetrievalChannel, MemoryRetrievalPlan, MemoryRetrievalPlanner } from "./planner.js";
import { extractKeywords } from "../scope.js";

function splitSentences(text: string): string[] {
  return String(text || "")
    .split(/[\n。！？!?；;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function describeQueryComplexity(prompt: string): MemoryRetrievalPlan["complexity"] {
  const text = String(prompt || "").trim();
  if (!text) return "simple";
  if (text.length > 180) return "complex";
  const sentenceCount = splitSentences(text).length;
  if (sentenceCount >= 3) return "complex";
  if (text.length > 70) return "hybrid";
  return "simple";
}

function choosePlanes(prompt: string, complexity: MemoryRetrievalPlan["complexity"]): MemoryPlane[] {
  const text = String(prompt || "").toLowerCase();
  const planes = new Set<MemoryPlane>();
  if (/规则|约束|规范|style|rule|abort|中文|简洁/.test(text)) planes.add("procedural");
  if (/偏好|喜欢|习惯|风格|preference|prefer/.test(text)) planes.add("profile");
  if (/项目|仓库|repo|workspace|模块|spec|bridge|memory/.test(text)) planes.add("project");
  if (/上次|之前|刚才|历史|recent|前面/.test(text)) planes.add("episodic");

  if (!planes.size) {
    planes.add("procedural");
    planes.add("project");
    if (complexity !== "simple") planes.add("episodic");
  }

  if (complexity !== "simple") planes.add("profile");
  if (complexity === "complex") planes.add("episodic");

  return [...planes];
}

function chooseLevels(planes: MemoryPlane[], complexity: MemoryRetrievalPlan["complexity"]): MemoryTemporalLevel[] {
  const levels = new Set<MemoryTemporalLevel>();
  if (planes.includes("procedural")) levels.add("T5");
  if (planes.includes("profile")) {
    levels.add("T3");
    levels.add("T5");
  }
  if (planes.includes("project")) {
    levels.add("T2");
    levels.add("T5");
    if (complexity !== "simple") levels.add("T4");
  }
  if (planes.includes("episodic")) {
    levels.add("T1");
    if (complexity !== "simple") levels.add("T2");
  }
  return [...levels];
}

function chooseChannels(complexity: MemoryRetrievalPlan["complexity"]): MemoryRetrievalChannel[] {
  if (complexity === "simple") return ["sparse", "graph", "temporal", "recent"];
  if (complexity === "hybrid") return ["dense", "sparse", "graph", "temporal", "recent"];
  return ["dense", "sparse", "graph", "temporal", "recent"];
}

function chooseScopeHints(complexity: MemoryRetrievalPlan["complexity"]): MemoryScopeKind[] {
  if (complexity === "simple") return ["chat-local", "workspace-global"];
  if (complexity === "hybrid") return ["chat-local", "workspace-global", "user-global"];
  return ["chat-local", "workspace-global", "user-global"];
}

function deriveClues(prompt: string, planes: MemoryPlane[], complexity: MemoryRetrievalPlan["complexity"]): string[] {
  const clues = new Set<string>(extractKeywords(prompt, complexity === "complex" ? 10 : 6));
  if (planes.includes("procedural")) clues.add("行为规则");
  if (planes.includes("profile")) clues.add("用户偏好");
  if (planes.includes("project")) clues.add("项目约束");
  if (planes.includes("episodic")) clues.add("近期历史");
  return [...clues].slice(0, complexity === "complex" ? 10 : 6);
}

export class HeuristicRetrievalPlanner implements MemoryRetrievalPlanner {
  plan(request: MemoryPromptContextRequest, limits: {
    maxRetrievedMemories: number;
    maxRecentTurns: number;
  }): MemoryRetrievalPlan {
    const complexity = describeQueryComplexity(request.prompt);
    const searchTerms = extractKeywords(request.prompt, complexity === "complex" ? 12 : 8)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2);
    const targetPlanes = choosePlanes(request.prompt, complexity);
    const targetLevels = chooseLevels(targetPlanes, complexity);
    const targetChannels = chooseChannels(complexity);
    const scopeHints = chooseScopeHints(complexity);
    const clues = deriveClues(request.prompt, targetPlanes, complexity);

    const maxCandidates = complexity === "complex"
      ? Math.max(limits.maxRetrievedMemories * 3, 18)
      : complexity === "hybrid"
        ? Math.max(limits.maxRetrievedMemories * 2, 12)
        : Math.max(limits.maxRetrievedMemories, 8);

    return {
      complexity,
      searchTerms,
      clues,
      targetPlanes,
      targetLevels,
      targetChannels,
      scopeHints,
      maxCandidates,
      maxFinalMemories: limits.maxRetrievedMemories,
      maxRecentTurns: complexity === "complex"
        ? limits.maxRecentTurns
        : Math.min(limits.maxRecentTurns, 4),
    };
  }
}
