// src/cron-types.ts — cron domain models

export type CronScheduleKind = "at" | "every" | "cron";

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

export type CronExecutor = (ctx: CronExecuteContext) => Promise<CronExecuteResult | void>;

export interface CronServiceStatus {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
  runningJobs: number;
  queuedJobs: number;
  nextRunAtMs?: number;
}

export interface CronServiceOptions {
  storePath: string;
  botName: string;
  enabled: boolean;
  defaultTimezone: string;
  maxJobsPerChat: number;
  maxRunMs: number;
  defaultPolicy: CronJobPolicy;
}
