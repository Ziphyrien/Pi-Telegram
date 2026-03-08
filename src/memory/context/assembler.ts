// src/memory/context/assembler.ts — context block assembly and prompt wrapping
import type { MemoryPromptContextResult } from "../types.js";

export function buildPromptEnvelope(memoryBlock: string, originalPrompt: string): string {
  if (!memoryBlock.trim()) return originalPrompt;
  return [
    "[Memory Context]",
    "以下内容来自长期记忆系统，仅在相关时使用；若与用户本轮明确要求冲突，以用户本轮要求为准。",
    memoryBlock.trim(),
    "[/Memory Context]",
    "",
    originalPrompt,
  ].join("\n");
}

export class MemoryContextAssembler {
  buildPrompt(memory: MemoryPromptContextResult, originalPrompt: string): string {
    return buildPromptEnvelope(memory.contextText, originalPrompt);
  }
}
