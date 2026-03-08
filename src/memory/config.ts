// src/memory/config.ts — memory model config resolution helpers
import type { MemoryEmbeddingConfig, MemoryLlmConfig } from "../shared/types.js";

function resolveApiKey(envName: string | undefined): string | undefined {
  if (!envName) return undefined;
  const value = process.env[envName];
  return value && String(value).trim() ? String(value).trim() : undefined;
}

export function hasUsableMemoryLlmConfig(config: MemoryLlmConfig | undefined): config is Required<Pick<MemoryLlmConfig, "provider" | "model" | "baseUrl" | "apiKeyEnv" | "api">> & Pick<MemoryLlmConfig, "authHeader"> {
  return Boolean(
    config?.provider
    && config?.model
    && config?.baseUrl
    && config?.apiKeyEnv
    && config?.api,
  );
}

export function hasUsableEmbeddingConfig(config: MemoryEmbeddingConfig | undefined): config is Required<Pick<MemoryEmbeddingConfig, "model" | "baseUrl" | "apiKeyEnv">> {
  return Boolean(
    config?.model
    && config?.baseUrl
    && config?.apiKeyEnv,
  );
}

export function getResolvedApiKey(envName: string | undefined): string | undefined {
  return resolveApiKey(envName);
}
