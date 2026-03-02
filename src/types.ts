// src/types.ts — all type definitions, no logic

export interface BotConfig {
  token: string;
  name: string;
  allowedUsers: (number | string)[];
  cwd: string;
  streamByChat?: Record<string, boolean>;
}

export interface CronConfig {
  enabled?: boolean;
  defaultTimezone?: string;
  maxJobsPerChat?: number;
  maxRunSeconds?: number;
  maxLatenessMs?: number;
  retryMax?: number;
  retryBackoffMs?: number;
}

export interface AppConfig {
  bots: BotConfig[];
  idleTimeoutMs: number;
  maxResponseLength: number;
  lastChangelogVersion?: string;
  cron?: CronConfig;
}

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
