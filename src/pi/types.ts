// src/pi/types.ts — pi RPC / model / session related types

export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export type PiTokenStats = Partial<Record<"total" | "input" | "output" | "cacheRead" | "cacheWrite", number>>;

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiSessionStats {
  cost?: number;
  totalMessages?: number;
  tokens?: PiTokenStats;
  contextUsage?: PiContextUsage;
}
