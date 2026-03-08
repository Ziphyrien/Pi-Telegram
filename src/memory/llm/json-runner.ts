// src/memory/llm/json-runner.ts — shared internal pi RPC JSON runner for memory LLM tasks
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PiRpc } from "../../pi/rpc.js";
import { log } from "../../shared/log.js";
import { hasUsableMemoryLlmConfig } from "../config.js";
import { generateProviderRegistrationExtension } from "../provider-extension/generator.js";
import type { MemoryLlmConfig } from "../../shared/types.js";

function extractJsonBlock(text: string): string | undefined {
  const trimmed = String(text || "").trim();
  if (!trimmed) return undefined;

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");

  const objectSpan = objectStart >= 0 && objectEnd > objectStart
    ? trimmed.slice(objectStart, objectEnd + 1)
    : undefined;
  const arraySpan = arrayStart >= 0 && arrayEnd > arrayStart
    ? trimmed.slice(arrayStart, arrayEnd + 1)
    : undefined;

  if (objectSpan && arraySpan) {
    return objectSpan.length >= arraySpan.length ? objectSpan : arraySpan;
  }
  return objectSpan ?? arraySpan;
}

export interface MemoryJsonRunnerOptions {
  cwd: string;
  purpose: string;
  prompt: string;
}

export class MemoryJsonRunner {
  constructor(
    private readonly llm: MemoryLlmConfig,
    private readonly providerExtensionEntryPath?: string,
  ) {}

  async runJson(options: MemoryJsonRunnerOptions): Promise<unknown | undefined> {
    if (!hasUsableMemoryLlmConfig(this.llm)) return undefined;

    const tempRoot = mkdtempSync(resolve(tmpdir(), "pi-memory-json-"));
    const generatedProvider = this.providerExtensionEntryPath
      ? undefined
      : generateProviderRegistrationExtension(tempRoot, {
        provider: this.llm.provider!,
        model: this.llm.model!,
        baseUrl: this.llm.baseUrl!,
        apiKeyEnv: this.llm.apiKeyEnv!,
        api: this.llm.api!,
        authHeader: this.llm.authHeader,
      });
    const providerEntryPath = this.providerExtensionEntryPath ?? generatedProvider?.entryPath;

    if (!providerEntryPath) {
      rmSync(tempRoot, { recursive: true, force: true });
      return undefined;
    }

    const rpc = new PiRpc(`memory-json-${options.purpose}-${Date.now()}`, {
      cwd: options.cwd,
      piArgs: ["--no-session", "--no-tools", "-e", providerEntryPath],
      sessionDir: resolve(tempRoot, "session"),
      continueSession: false,
    });

    rpc.start();
    try {
      await rpc.rpcSetModel(this.llm.provider!, this.llm.model!);
      const result = await rpc.prompt(options.prompt);
      const jsonBlock = extractJsonBlock(result.text);
      if (!jsonBlock) return undefined;
      return JSON.parse(jsonBlock);
    } catch (err) {
      log.warn(`memory ${options.purpose} json runner failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      rpc.kill();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
