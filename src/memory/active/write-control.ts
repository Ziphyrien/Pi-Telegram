// src/memory/active/write-control.ts — admission control and operation decision overlay for write path
import type { MemoryCandidate } from "../types.js";

export type MemoryWriteOperation = "add" | "update" | "replace" | "delete" | "noop" | "link" | "evolve";

export interface MemoryOperationDecision {
  admitted: boolean;
  operation: MemoryWriteOperation;
  reason: string;
}

function hintedAdmission(candidate: MemoryCandidate): boolean | undefined {
  const hint = String(candidate.metadata?.admissionHint || "").trim().toLowerCase();
  if (!hint) return undefined;
  if (["allow", "admit", "yes", "remember", "true"].includes(hint)) return true;
  if (["reject", "deny", "no", "skip", "false"].includes(hint)) return false;
  return undefined;
}

function hintedOperation(candidate: MemoryCandidate): MemoryWriteOperation | undefined {
  const hint = String(candidate.metadata?.operationHint || candidate.metadata?.operationDecision || "").trim().toLowerCase();
  switch (hint) {
    case "add": return "add";
    case "update": return "update";
    case "replace": return "replace";
    case "delete": return "delete";
    case "noop": return "noop";
    case "link": return "link";
    case "evolve": return "evolve";
    default:
      return undefined;
  }
}

export class MemoryAdmissionController {
  admit(candidate: MemoryCandidate): boolean {
    const hinted = hintedAdmission(candidate);
    if (typeof hinted === "boolean") return hinted;
    if (!candidate.summary.trim()) return false;
    if (candidate.importance < 0.2) return false;
    if (candidate.confidence < 0.25) return false;
    return true;
  }
}

export class MemoryOperationDecider {
  decide(candidate: MemoryCandidate): MemoryOperationDecision {
    if (!candidate.summary.trim()) {
      return { admitted: false, operation: "noop", reason: "empty-summary" };
    }

    const hinted = hintedOperation(candidate);
    if (hinted) {
      return { admitted: hinted !== "noop", operation: hinted, reason: "llm-hint" };
    }

    if (candidate.type === "behavior_correction") {
      return { admitted: true, operation: "update", reason: "behavior-correction" };
    }
    if (candidate.plane === "procedural") {
      return { admitted: true, operation: "update", reason: "procedural-rule" };
    }
    if (candidate.temporalLevel !== "T1") {
      return { admitted: true, operation: "evolve", reason: "higher-level-consolidation" };
    }
    return { admitted: true, operation: candidate.upsertByFamily ? "update" : "add", reason: "default-write-path" };
  }
}
