// src/memory/provider-extension/generator.ts — temporary provider-registration extension generator
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MemoryLlmConfig } from "../../shared/types.js";

export interface GeneratedProviderExtension {
  dir: string;
  entryPath: string;
}

function escapeString(value: string): string {
  return JSON.stringify(String(value));
}

export function generateProviderRegistrationExtension(baseDir: string, config: Required<Pick<MemoryLlmConfig, "provider" | "model" | "baseUrl" | "apiKeyEnv" | "api">> & Pick<MemoryLlmConfig, "authHeader">): GeneratedProviderExtension {
  const dir = resolve(baseDir, "pi-memory-provider-extension");
  const entryPath = resolve(dir, "index.ts");
  mkdirSync(dir, { recursive: true });

  const source = `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function memoryProvider(pi: ExtensionAPI) {
  pi.registerProvider(${escapeString(config.provider)}, {
    baseUrl: ${escapeString(config.baseUrl)},
    apiKey: ${escapeString(config.apiKeyEnv)},
    api: ${escapeString(config.api)},
    authHeader: ${config.authHeader ? "true" : "false"},
    models: [
      {
        id: ${escapeString(config.model)},
        name: ${escapeString(config.model)},
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192
      }
    ]
  });
}
`;

  writeFileSync(resolve(dir, "package.json"), JSON.stringify({
    name: "pi-memory-provider-extension",
    private: true,
    type: "module",
    pi: { extensions: ["./index.ts"] },
  }, null, 2) + "\n", "utf-8");
  writeFileSync(entryPath, source, "utf-8");
  return { dir, entryPath };
}
