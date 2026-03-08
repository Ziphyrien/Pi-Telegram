// src/memory/embedding/openai-client.ts — direct embedding client via OpenAI-compatible endpoint
import { getResolvedApiKey } from "../config.js";
import type { MemoryEmbeddingConfig } from "../../shared/types.js";

export class OpenAIEmbeddingClient {
  constructor(private readonly config: Required<Pick<MemoryEmbeddingConfig, "model" | "baseUrl" | "apiKeyEnv">>) {}

  async embed(input: string): Promise<number[]> {
    const apiKey = getResolvedApiKey(this.config.apiKeyEnv);
    if (!apiKey) {
      throw new Error(`embedding api key env not set: ${this.config.apiKeyEnv}`);
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new Error("embedding response missing vector");
    }
    return vector.map((x) => Number(x));
  }
}

export function canCreateEmbeddingClient(config: MemoryEmbeddingConfig | undefined): config is Required<Pick<MemoryEmbeddingConfig, "model" | "baseUrl" | "apiKeyEnv">> {
  return Boolean(config?.model && config?.baseUrl && config?.apiKeyEnv);
}
