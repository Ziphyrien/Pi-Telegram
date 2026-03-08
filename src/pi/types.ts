// src/pi/types.ts — pi RPC / model / session related types

export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptResult {
  text: string;
  tools: string[];
}

export interface PiRpcEvent {
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  toolName?: string;
  isError?: boolean;
  messages?: unknown[];
}

export interface PiModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface PiSessionStats {
  cost?: number;
  totalMessages?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}
