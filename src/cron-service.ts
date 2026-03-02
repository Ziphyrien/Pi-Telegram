// src/cron-service.ts — persistent cron scheduler for Pi-Telegram
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { Cron } from "croner";
import { log } from "./log.js";
import type {
  CronCreateInput,
  CronExecuteContext,
  CronExecutor,
  CronJobPolicy,
  CronJobRecord,
  CronSchedule,
  CronServiceOptions,
  CronServiceStatus,
  CronStoreData,
} from "./cron-types.js";

const STORE_VERSION = 1 as const;
const MAX_TIMER_SLICE_MS = 24 * 60 * 60 * 1000; // 24h

type RunSource = CronExecuteContext["source"];

interface RunRequest {
  jobId: string;
  source: RunSource;
  scheduledAtMs: number;
  force: boolean;
}

export class CronService {
  private readonly jobs = new Map<string, CronJobRecord>();
  private readonly cronHandles = new Map<string, Cron>();
  private readonly timerHandles = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runQueue: RunRequest[] = [];
  private readonly queuedJobIds = new Set<string>();

  private started = false;
  private stopping = false;
  private processingQueue = false;
  private activeRuns = 0;

  private writeQueue: Promise<void> = Promise.resolve();
  private opQueue: Promise<void> = Promise.resolve();

  private executor: CronExecutor | null = null;

  constructor(private readonly opts: CronServiceOptions) {
    const dir = dirname(this.opts.storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  getDefaultTimezone(): string {
    return this.opts.defaultTimezone;
  }

  async start(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.started) return;
      this.stopping = false;

      await this.loadStoreUnsafe();
      const changed = this.recoverDanglingRunsUnsafe();

      if (this.opts.enabled) {
        for (const job of this.jobs.values()) {
          this.scheduleJobUnsafe(job, true);
        }
      }

      if (changed) {
        await this.persistUnsafe();
      }

      this.started = true;
      log.boot(`cron started (${this.opts.botName}, jobs=${this.jobs.size})`);
    });
  }

  async stop(): Promise<void> {
    await this.runExclusive(async () => {
      if (!this.started && this.stopping) return;
      this.stopping = true;
      this.clearAllSchedulesUnsafe();
      this.started = false;
    });

    const deadline = Date.now() + 10_000;
    while (this.activeRuns > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  }

  list(chatId?: number): CronJobRecord[] {
    const jobs = [...this.jobs.values()]
      .filter((x) => (typeof chatId === "number" ? x.chatId === chatId : true))
      .map(cloneJob)
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const an = a.state.nextRunAtMs || Number.MAX_SAFE_INTEGER;
        const bn = b.state.nextRunAtMs || Number.MAX_SAFE_INTEGER;
        if (an !== bn) return an - bn;
        return a.createdAtMs - b.createdAtMs;
      });
    return jobs;
  }

  get(jobId: string): CronJobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  status(chatId?: number): CronServiceStatus {
    const jobs = [...this.jobs.values()].filter((x) => (typeof chatId === "number" ? x.chatId === chatId : true));
    const enabledJobs = jobs.filter((x) => x.enabled).length;
    const runningJobs = jobs.filter((x) => !!x.state.runningRunId).length;
    const nextRunAtMs = jobs
      .filter((x) => x.enabled && x.state.nextRunAtMs > 0)
      .map((x) => x.state.nextRunAtMs)
      .sort((a, b) => a - b)[0];

    return {
      enabled: this.opts.enabled,
      totalJobs: jobs.length,
      enabledJobs,
      runningJobs,
      queuedJobs: this.runQueue.length,
      nextRunAtMs,
    };
  }

  async create(input: CronCreateInput): Promise<CronJobRecord> {
    return this.runExclusive(async () => {
      const prompt = String(input.prompt || "").trim();
      if (!prompt) throw new Error("任务内容不能为空");

      const chatId = Number(input.chatId);
      if (!Number.isSafeInteger(chatId)) throw new Error("chatId 非法");

      const perChatCount = [...this.jobs.values()].filter((x) => x.chatId === chatId).length;
      if (perChatCount >= this.opts.maxJobsPerChat) {
        throw new Error(`当前聊天任务已达上限（${this.opts.maxJobsPerChat}）`);
      }

      const now = Date.now();
      const id = this.generateIdUnsafe();
      const schedule = normalizeSchedule(input.schedule, this.opts.defaultTimezone, now);
      const policy = normalizePolicy(input.policy, this.opts.defaultPolicy);

      const job: CronJobRecord = {
        id,
        botName: this.opts.botName,
        chatId,
        name: normalizeJobName(input.name, prompt, id),
        prompt,
        enabled: input.enabled ?? true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule,
        policy,
        state: {
          nextRunAtMs: initialNextRun(schedule, now),
          consecutiveFailures: 0,
        },
      };

      this.jobs.set(job.id, job);
      this.scheduleJobUnsafe(job, false);
      await this.persistUnsafe();
      return cloneJob(job);
    });
  }

  async remove(jobId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const job = this.jobs.get(jobId);
      if (!job) return false;

      this.unscheduleJobUnsafe(jobId);
      this.jobs.delete(jobId);
      this.queuedJobIds.delete(jobId);
      removeInPlace(this.runQueue, (x) => x.jobId === jobId);
      await this.persistUnsafe();
      return true;
    });
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<CronJobRecord | undefined> {
    return this.runExclusive(async () => {
      const job = this.jobs.get(jobId);
      if (!job) return undefined;

      job.enabled = enabled;
      job.updatedAtMs = Date.now();

      if (!enabled) {
        job.state.nextRunAtMs = 0;
        this.unscheduleJobUnsafe(jobId);
      } else {
        if (job.schedule.kind === "at" && job.state.nextRunAtMs <= 0) {
          job.state.nextRunAtMs = job.schedule.atMs;
        }
        if (job.schedule.kind === "every" && job.state.nextRunAtMs <= 0) {
          job.state.nextRunAtMs = computeEveryNextAt(job.schedule.anchorMs, job.schedule.everyMs, Date.now());
        }
        this.scheduleJobUnsafe(job, false);
      }

      await this.persistUnsafe();
      return cloneJob(job);
    });
  }

  async rename(jobId: string, name: string): Promise<CronJobRecord | undefined> {
    return this.runExclusive(async () => {
      const job = this.jobs.get(jobId);
      if (!job) return undefined;

      job.name = normalizeJobName(name, job.prompt, job.id);
      job.updatedAtMs = Date.now();
      await this.persistUnsafe();
      return cloneJob(job);
    });
  }

  async runNow(jobId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const job = this.jobs.get(jobId);
      if (!job) return false;

      this.enqueueRunUnsafe({
        jobId,
        source: "manual",
        scheduledAtMs: Date.now(),
        force: true,
      });

      return true;
    });
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.opQueue.then(fn, fn);
    this.opQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async loadStoreUnsafe(): Promise<void> {
    this.jobs.clear();

    if (!existsSync(this.opts.storePath)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.opts.storePath, "utf-8"));
    } catch (err) {
      log.error("cron", `cron store parse failed (${this.opts.storePath}): ${toErrorMessage(err)}`);
      return;
    }

    const jobs = Array.isArray((parsed as any)?.jobs) ? (parsed as any).jobs : [];
    const now = Date.now();

    for (const raw of jobs) {
      try {
        const job = normalizeLoadedJob(raw, this.opts.botName, this.opts.defaultPolicy, this.opts.defaultTimezone, now);
        if (!job) continue;
        this.jobs.set(job.id, job);
      } catch (err) {
        log.warn(`cron 跳过非法任务：${toErrorMessage(err)}`);
      }
    }
  }

  private recoverDanglingRunsUnsafe(): boolean {
    const now = Date.now();
    let changed = false;

    for (const job of this.jobs.values()) {
      if (!job.state.runningRunId) continue;

      job.state.runningRunId = undefined;
      job.state.runningAtMs = undefined;
      job.state.lastStatus = "error";
      job.state.lastError = "检测到上次进程异常退出，任务已恢复待调度";
      job.state.consecutiveFailures += 1;
      job.updatedAtMs = now;

      if (!job.enabled) continue;

      switch (job.schedule.kind) {
        case "at":
          if (job.state.nextRunAtMs <= 0) {
            job.state.nextRunAtMs = job.schedule.atMs;
          }
          break;
        case "every":
          if (job.state.nextRunAtMs <= 0) {
            job.state.nextRunAtMs = computeEveryNextAt(job.schedule.anchorMs, job.schedule.everyMs, now);
          }
          break;
        case "cron":
          // next run is refreshed by scheduleJobUnsafe
          break;
      }

      changed = true;
    }

    return changed;
  }

  private clearAllSchedulesUnsafe(): void {
    for (const t of this.timerHandles.values()) {
      clearTimeout(t);
    }
    this.timerHandles.clear();

    for (const c of this.cronHandles.values()) {
      c.stop();
    }
    this.cronHandles.clear();
  }

  private unscheduleJobUnsafe(jobId: string): void {
    const t = this.timerHandles.get(jobId);
    if (t) {
      clearTimeout(t);
      this.timerHandles.delete(jobId);
    }

    const c = this.cronHandles.get(jobId);
    if (c) {
      c.stop();
      this.cronHandles.delete(jobId);
    }
  }

  private scheduleJobUnsafe(job: CronJobRecord, startup: boolean): void {
    this.unscheduleJobUnsafe(job.id);

    if (!this.started && !startup) return;
    if (this.stopping) return;
    if (!this.opts.enabled) return;
    if (!job.enabled) return;

    const now = Date.now();

    if (job.schedule.kind === "cron") {
      try {
        const cron = new Cron(job.schedule.expr, { timezone: job.schedule.timezone }, () => {
          this.onCronTick(job.id);
        });
        this.cronHandles.set(job.id, cron);
        const next = cron.nextRun();
        job.state.nextRunAtMs = next ? next.getTime() : 0;
      } catch (err) {
        job.enabled = false;
        job.state.lastStatus = "error";
        job.state.lastError = `cron 表达式无效：${toErrorMessage(err)}`;
        job.state.nextRunAtMs = 0;
      }
      return;
    }

    const dueAt = this.computeDueAtUnsafe(job, now, startup);
    job.state.nextRunAtMs = dueAt;

    if (dueAt <= 0) return;

    if (dueAt <= now) {
      this.enqueueRunUnsafe({
        jobId: job.id,
        source: startup ? "startup-catchup" : "timer",
        scheduledAtMs: dueAt,
        force: false,
      });
      return;
    }

    this.armTimerUnsafe(job.id, dueAt);
  }

  private computeDueAtUnsafe(job: CronJobRecord, now: number, startup: boolean): number {
    switch (job.schedule.kind) {
      case "at": {
        const target = job.state.nextRunAtMs > 0 ? job.state.nextRunAtMs : job.schedule.atMs;
        if (target > now) return target;

        const lateness = now - target;
        if (lateness > job.policy.maxLatenessMs) {
          job.enabled = false;
          job.state.lastStatus = "missed";
          job.state.lastError = "任务已过期，超过允许延迟窗口";
          return 0;
        }

        return now;
      }

      case "every": {
        const next = job.state.nextRunAtMs > 0
          ? job.state.nextRunAtMs
          : computeEveryNextAt(job.schedule.anchorMs, job.schedule.everyMs, now);

        if (next <= now) {
          return startup ? now : next;
        }

        return next;
      }

      default:
        return 0;
    }
  }

  private armTimerUnsafe(jobId: string, dueAtMs: number): void {
    const now = Date.now();
    const delay = Math.max(0, Math.min(dueAtMs - now, MAX_TIMER_SLICE_MS));

    const timer = setTimeout(() => {
      this.onTimer(jobId, dueAtMs);
    }, delay);

    this.timerHandles.set(jobId, timer);
  }

  private onTimer(jobId: string, dueAtMs: number): void {
    void this.runExclusive(async () => {
      this.timerHandles.delete(jobId);

      if (this.stopping || !this.opts.enabled) return;
      const job = this.jobs.get(jobId);
      if (!job || !job.enabled) return;

      const now = Date.now();
      if (dueAtMs - now > 1000) {
        this.armTimerUnsafe(jobId, dueAtMs);
        return;
      }

      this.enqueueRunUnsafe({
        jobId,
        source: "timer",
        scheduledAtMs: dueAtMs,
        force: false,
      });
    });
  }

  private onCronTick(jobId: string): void {
    void this.runExclusive(async () => {
      if (this.stopping || !this.opts.enabled) return;

      const job = this.jobs.get(jobId);
      if (!job || !job.enabled || job.schedule.kind !== "cron") return;

      const scheduledAtMs = job.state.nextRunAtMs || Date.now();
      const handle = this.cronHandles.get(jobId);
      const next = handle?.nextRun();
      job.state.nextRunAtMs = next ? next.getTime() : 0;
      job.updatedAtMs = Date.now();
      await this.persistUnsafe();

      this.enqueueRunUnsafe({
        jobId,
        source: "cron",
        scheduledAtMs,
        force: false,
      });
    });
  }

  private enqueueRunUnsafe(req: RunRequest): void {
    const job = this.jobs.get(req.jobId);
    if (!job) return;

    if (this.queuedJobIds.has(req.jobId)) return;
    if (job.state.runningRunId) return;

    this.runQueue.push(req);
    this.queuedJobIds.add(req.jobId);
    void this.processRunQueue();
  }

  private async processRunQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    try {
      while (this.runQueue.length > 0) {
        if (this.stopping) break;

        const req = this.runQueue.shift()!;
        this.queuedJobIds.delete(req.jobId);

        await this.executeRun(req);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async executeRun(req: RunRequest): Promise<void> {
    const kicked = await this.runExclusive(async () => {
      const job = this.jobs.get(req.jobId);
      if (!job) return undefined;
      if (!job.enabled && !req.force) return undefined;
      if (job.state.runningRunId) return undefined;

      const runId = randomUUID();
      const now = Date.now();
      job.state.runningRunId = runId;
      job.state.runningAtMs = now;
      job.updatedAtMs = now;
      await this.persistUnsafe();

      return {
        runId,
        job: cloneJob(job),
      };
    });

    if (!kicked) return;

    this.activeRuns += 1;
    const startedAt = Date.now();

    const result = await this.runExecutor({
      job: kicked.job,
      runId: kicked.runId,
      source: req.source,
      scheduledAtMs: req.scheduledAtMs,
    });

    const endedAt = Date.now();
    const duration = Math.max(0, endedAt - startedAt);

    await this.runExclusive(async () => {
      const job = this.jobs.get(req.jobId);
      if (!job) return;
      if (job.state.runningRunId !== kicked.runId) return;

      job.state.runningRunId = undefined;
      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = endedAt;
      job.state.lastDurationMs = duration;
      job.updatedAtMs = endedAt;

      if (result.ok) {
        job.state.lastStatus = "ok";
        job.state.lastError = "";
        job.state.consecutiveFailures = 0;
      } else {
        job.state.lastStatus = "error";
        job.state.lastError = result.error || "unknown error";
        job.state.consecutiveFailures += 1;
      }

      if (job.schedule.kind === "at") {
        await this.handleAtCompletionUnsafe(job, endedAt, result.ok);
      } else if (job.schedule.kind === "every") {
        job.state.nextRunAtMs = computeEveryNextAt(job.schedule.anchorMs, job.schedule.everyMs, endedAt);
        this.scheduleJobUnsafe(job, false);
      } else {
        const handle = this.cronHandles.get(job.id);
        const next = handle?.nextRun();
        job.state.nextRunAtMs = next ? next.getTime() : 0;
      }

      await this.persistUnsafe();
    });

    this.activeRuns = Math.max(0, this.activeRuns - 1);
  }

  private async handleAtCompletionUnsafe(job: CronJobRecord, now: number, ok: boolean): Promise<void> {
    if (ok) {
      if (job.policy.deleteAfterRun) {
        this.unscheduleJobUnsafe(job.id);
        this.jobs.delete(job.id);
        this.queuedJobIds.delete(job.id);
        removeInPlace(this.runQueue, (x) => x.jobId === job.id);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = 0;
      }
      return;
    }

    if (job.state.consecutiveFailures <= job.policy.retryMax) {
      const factor = Math.max(0, job.state.consecutiveFailures - 1);
      const backoff = job.policy.retryBackoffMs * 2 ** factor;
      const retryAt = now + backoff;
      job.state.nextRunAtMs = retryAt;
      this.scheduleJobUnsafe(job, false);
      return;
    }

    job.enabled = false;
    job.state.nextRunAtMs = 0;
  }

  private async runExecutor(ctx: CronExecuteContext): Promise<{ ok: boolean; error?: string }> {
    if (!this.executor) {
      return { ok: false, error: "cron executor 未配置" };
    }

    const timeoutMs = Math.max(5_000, this.opts.maxRunMs);

    const timeoutError = `任务执行超时（>${Math.round(timeoutMs / 1000)}s）`;

    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
      const run = Promise.resolve(this.executor(ctx));
      const timer = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        timeout = setTimeout(() => resolve({ ok: false, error: timeoutError }), timeoutMs);
      });

      const output = await Promise.race([
        run
          .then((res) => ({ ok: res?.ok !== false, error: res?.error }))
          .catch((err) => ({ ok: false, error: toErrorMessage(err) })),
        timer,
      ]);

      return output;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async persistUnsafe(): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const data: CronStoreData = {
        version: STORE_VERSION,
        updatedAtMs: Date.now(),
        jobs: [...this.jobs.values()].map(cloneJob),
      };

      const json = `${JSON.stringify(data, null, 2)}\n`;
      const tmpPath = `${this.opts.storePath}.tmp`;

      await writeFile(tmpPath, json, "utf-8");
      try {
        await rename(tmpPath, this.opts.storePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "EPERM") {
          await rm(this.opts.storePath, { force: true });
          await rename(tmpPath, this.opts.storePath);
        } else {
          throw err;
        }
      }
    });

    this.writeQueue = task.catch(() => {
      // Keep chain alive.
    });

    await task;
  }

  private generateIdUnsafe(): string {
    for (let i = 0; i < 8; i += 1) {
      const id = randomUUID().replace(/-/g, "").slice(0, 10);
      if (!this.jobs.has(id)) return id;
    }
    return randomUUID().replace(/-/g, "");
  }
}

function normalizeSchedule(schedule: CronSchedule, defaultTimezone: string, now: number): CronSchedule {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("缺少 schedule");
  }

  switch (schedule.kind) {
    case "at": {
      const atMs = Number(schedule.atMs);
      if (!Number.isFinite(atMs) || atMs <= 0) {
        throw new Error("atMs 非法");
      }
      return { kind: "at", atMs: Math.floor(atMs) };
    }

    case "every": {
      const everyMs = Number(schedule.everyMs);
      const anchorMs = Number(schedule.anchorMs || now);
      if (!Number.isFinite(everyMs) || everyMs < 1000) {
        throw new Error("everyMs 不能小于 1000ms");
      }
      if (!Number.isFinite(anchorMs) || anchorMs <= 0) {
        throw new Error("anchorMs 非法");
      }
      return {
        kind: "every",
        everyMs: Math.floor(everyMs),
        anchorMs: Math.floor(anchorMs),
      };
    }

    case "cron": {
      const expr = String(schedule.expr || "").trim();
      if (!expr) throw new Error("cron 表达式不能为空");
      const timezone = String(schedule.timezone || defaultTimezone).trim() || defaultTimezone;
      return { kind: "cron", expr, timezone };
    }

    default:
      throw new Error(`未知 schedule.kind: ${(schedule as any)?.kind}`);
  }
}

function normalizePolicy(policy: Partial<CronJobPolicy> | undefined, defaults: CronJobPolicy): CronJobPolicy {
  const maxLatenessMs = Number(policy?.maxLatenessMs ?? defaults.maxLatenessMs);
  const retryMax = Number(policy?.retryMax ?? defaults.retryMax);
  const retryBackoffMs = Number(policy?.retryBackoffMs ?? defaults.retryBackoffMs);
  const deleteAfterRun = policy?.deleteAfterRun ?? defaults.deleteAfterRun;

  return {
    maxLatenessMs: Number.isFinite(maxLatenessMs) && maxLatenessMs >= 0
      ? Math.floor(maxLatenessMs)
      : defaults.maxLatenessMs,
    retryMax: Number.isFinite(retryMax) && retryMax >= 0
      ? Math.floor(retryMax)
      : defaults.retryMax,
    retryBackoffMs: Number.isFinite(retryBackoffMs) && retryBackoffMs >= 1000
      ? Math.floor(retryBackoffMs)
      : defaults.retryBackoffMs,
    deleteAfterRun: Boolean(deleteAfterRun),
  };
}

function initialNextRun(schedule: CronSchedule, now: number): number {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs;
    case "every":
      return computeEveryNextAt(schedule.anchorMs, schedule.everyMs, now);
    case "cron":
      return 0;
    default:
      return 0;
  }
}

function computeEveryNextAt(anchorMs: number, everyMs: number, now: number): number {
  const anchor = Math.max(1, Math.floor(anchorMs));
  const interval = Math.max(1000, Math.floor(everyMs));

  if (now < anchor) return anchor;

  const elapsed = now - anchor;
  const steps = Math.floor(elapsed / interval) + 1;
  return anchor + steps * interval;
}

function normalizeLoadedJob(
  raw: unknown,
  botName: string,
  defaultPolicy: CronJobPolicy,
  defaultTimezone: string,
  now: number,
): CronJobRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;

  const id = String(rec.id || "").trim();
  if (!id) return null;

  const chatId = Number(rec.chatId);
  if (!Number.isSafeInteger(chatId)) return null;

  const schedule = normalizeSchedule(rec.schedule as CronSchedule, defaultTimezone, now);
  const policy = normalizePolicy(rec.policy as Partial<CronJobPolicy> | undefined, defaultPolicy);

  const stateRaw = (rec.state && typeof rec.state === "object") ? rec.state as Record<string, unknown> : {};
  const nextRunAtMsRaw = Number(stateRaw.nextRunAtMs);
  const nextRunAtMs = Number.isFinite(nextRunAtMsRaw) && nextRunAtMsRaw > 0
    ? Math.floor(nextRunAtMsRaw)
    : initialNextRun(schedule, now);

  const createdAtMsRaw = Number(rec.createdAtMs);
  const updatedAtMsRaw = Number(rec.updatedAtMs);

  return {
    id,
    botName: String(rec.botName || botName),
    chatId,
    prompt: String(rec.prompt || "").trim(),
    name: normalizeJobName(rec.name, String(rec.prompt || ""), id),
    enabled: rec.enabled !== false,
    createdAtMs: Number.isFinite(createdAtMsRaw) && createdAtMsRaw > 0 ? Math.floor(createdAtMsRaw) : now,
    updatedAtMs: Number.isFinite(updatedAtMsRaw) && updatedAtMsRaw > 0 ? Math.floor(updatedAtMsRaw) : now,
    schedule,
    policy,
    state: {
      nextRunAtMs,
      runningRunId: typeof stateRaw.runningRunId === "string" && stateRaw.runningRunId.trim()
        ? stateRaw.runningRunId
        : undefined,
      runningAtMs: Number.isFinite(Number(stateRaw.runningAtMs))
        ? Math.floor(Number(stateRaw.runningAtMs))
        : undefined,
      lastRunAtMs: Number.isFinite(Number(stateRaw.lastRunAtMs))
        ? Math.floor(Number(stateRaw.lastRunAtMs))
        : undefined,
      lastStatus: normalizeLastStatus(stateRaw.lastStatus),
      lastError: typeof stateRaw.lastError === "string" ? stateRaw.lastError : "",
      lastDurationMs: Number.isFinite(Number(stateRaw.lastDurationMs))
        ? Math.floor(Number(stateRaw.lastDurationMs))
        : undefined,
      consecutiveFailures: Number.isFinite(Number(stateRaw.consecutiveFailures))
        ? Math.max(0, Math.floor(Number(stateRaw.consecutiveFailures)))
        : 0,
    },
  };
}

function normalizeJobName(nameInput: unknown, prompt: string, id: string): string {
  const raw = String(nameInput ?? "").trim();
  const source = raw || deriveNameFromPrompt(prompt, id);

  const normalized = source
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!normalized) return `任务-${id}`;
  if (normalized.length <= 48) return normalized;
  return `${normalized.slice(0, 48)}…`;
}

function deriveNameFromPrompt(prompt: string, id: string): string {
  const p = String(prompt || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!p) return `任务-${id}`;

  const keyword = p
    .replace(/^(["'“”‘’\-•\s]+)/, "")
    .trim();

  if (!keyword) return `任务-${id}`;
  if (keyword.length <= 24) return keyword;
  return `${keyword.slice(0, 24)}…`;
}

function normalizeLastStatus(v: unknown): "ok" | "error" | "missed" | undefined {
  if (v === "ok" || v === "error" || v === "missed") return v;
  return undefined;
}

function cloneJob(job: CronJobRecord): CronJobRecord {
  return {
    ...job,
    schedule: cloneSchedule(job.schedule),
    policy: { ...job.policy },
    state: { ...job.state },
  };
}

function cloneSchedule(schedule: CronSchedule): CronSchedule {
  switch (schedule.kind) {
    case "at":
      return { ...schedule };
    case "every":
      return { ...schedule };
    case "cron":
      return { ...schedule };
    default:
      return schedule;
  }
}

function removeInPlace<T>(arr: T[], fn: (item: T) => boolean): void {
  let i = 0;
  while (i < arr.length) {
    if (fn(arr[i])) {
      arr.splice(i, 1);
    } else {
      i += 1;
    }
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
