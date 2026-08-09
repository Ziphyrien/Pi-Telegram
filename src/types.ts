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

export interface CronScheduleAt {
  kind: "at";
  atMs: number;
}

export interface CronScheduleEvery {
  kind: "every";
  everyMs: number;
  anchorMs: number;
}

export interface CronScheduleCron {
  kind: "cron";
  expr: string;
  timezone: string;
}

export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export interface CronJobPolicy {
  maxLatenessMs: number;
  retryMax: number;
  retryBackoffMs: number;
  deleteAfterRun: boolean;
}

export interface CronJobState {
  nextRunAtMs: number;
  runningRunId?: string;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "missed";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveFailures: number;
}

export interface CronJobRecord {
  id: string;
  botName: string;
  chatId: number;
  name: string;
  prompt: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  policy: CronJobPolicy;
  state: CronJobState;
}

export interface CronStoreData {
  version: 1;
  jobs: CronJobRecord[];
  updatedAtMs: number;
}

export interface CronCreateInput {
  chatId: number;
  name?: string;
  prompt: string;
  enabled?: boolean;
  schedule: CronSchedule;
  policy?: Partial<CronJobPolicy>;
}

export interface CronExecuteContext {
  job: CronJobRecord;
  runId: string;
  source: "timer" | "cron" | "manual" | "startup-catchup" | "retry";
  scheduledAtMs: number;
}

export interface CronExecuteResult {
  ok?: boolean;
  error?: string;
}

export type CronExecutor = (context: CronExecuteContext) => Promise<CronExecuteResult | void>;

export interface SchedulerStatus {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
  runningJobs: number;
  queuedJobs: number;
  nextRunAtMs?: number;
}

export interface SchedulerOptions {
  storePath: string;
  botName: string;
  enabled: boolean;
  defaultTimezone: string;
  maxJobsPerChat: number;
  maxRunMs: number;
  defaultPolicy: CronJobPolicy;
  executorTimeoutMs?: number;
}
