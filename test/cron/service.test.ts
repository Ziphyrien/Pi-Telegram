import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService } from "../../src/cron/service.js";
import type { CronExecuteContext, CronJobRecord, CronServiceOptions, CronStoreData } from "../../src/cron/types.js";

// @covers cron/service.ts

const defaultPolicy = {
  maxLatenessMs: 60_000,
  retryMax: 1,
  retryBackoffMs: 1_000,
  deleteAfterRun: true,
};

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "pitg-cron-service-")), "jobs.json");
}

function createService(overrides: Partial<CronServiceOptions> = {}): CronService {
  return new CronService({
    storePath: tempStorePath(),
    botName: "test-bot",
    enabled: false,
    defaultTimezone: "UTC",
    maxJobsPerChat: 2,
    maxRunMs: 50,
    defaultPolicy,
    ...overrides,
  });
}

async function waitFor<T>(read: () => T | undefined, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 1_000;
  let last: T | undefined;

  while (Date.now() < deadline) {
    last = read();
    if (last !== undefined && accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(`condition was not met before timeout; last=${JSON.stringify(last)}`);
}

function readStore(path: string): CronStoreData {
  return JSON.parse(readFileSync(path, "utf-8")) as CronStoreData;
}

describe("CronService", () => {
  test("creates jobs with normalized schedule, policy, derived name, and persisted store", async () => {
    const storePath = tempStorePath();
    const service = createService({ storePath });

    const job = await service.create({
      chatId: 123,
      prompt: "  - check alarms and summarize  ",
      schedule: { kind: "every", everyMs: 1500.9, anchorMs: 1000.9 },
      policy: { maxLatenessMs: 1.9, retryMax: 2.7, retryBackoffMs: 1500.9, deleteAfterRun: false },
    });

    assert.equal(job.botName, "test-bot");
    assert.equal(job.chatId, 123);
    assert.equal(job.prompt, "- check alarms and summarize");
    assert.equal(job.name, "check alarms and summari…");
    assert.deepEqual(job.schedule, { kind: "every", everyMs: 1500, anchorMs: 1000 });
    assert.deepEqual(job.policy, {
      maxLatenessMs: 1,
      retryMax: 2,
      retryBackoffMs: 1500,
      deleteAfterRun: false,
    });
    assert.equal(service.status(123).totalJobs, 1);

    const store = readStore(storePath);
    assert.equal(store.version, 1);
    assert.equal(store.jobs.length, 1);
    assert.equal(store.jobs[0].id, job.id);
  });

  test("validates create input and enforces per-chat job limits", async () => {
    const service = createService({ maxJobsPerChat: 1 });

    await assert.rejects(
      () => service.create({ chatId: 1, prompt: " ", schedule: { kind: "at", atMs: Date.now() + 60_000 } }),
      /任务内容不能为空/,
    );
    await assert.rejects(
      () => service.create({ chatId: Number.NaN, prompt: "x", schedule: { kind: "at", atMs: Date.now() + 60_000 } }),
      /chatId 非法/,
    );

    await service.create({ chatId: 1, prompt: "first", schedule: { kind: "at", atMs: Date.now() + 60_000 } });
    await assert.rejects(
      () => service.create({ chatId: 1, prompt: "second", schedule: { kind: "at", atMs: Date.now() + 60_000 } }),
      /当前聊天任务已达上限/,
    );
  });

  test("returns clones from list/get and supports rename, enable, disable, and remove", async () => {
    const service = createService();
    const job = await service.create({
      chatId: 7,
      name: "  original\nname  ",
      prompt: "prompt",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      policy: { deleteAfterRun: false },
    });

    const listed = service.list(7);
    listed[0].name = "mutated outside";
    assert.equal(service.get(job.id)?.name, "original name");

    const disabled = await service.setEnabled(job.id, false);
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.state.nextRunAtMs, 0);

    const enabled = await service.setEnabled(job.id, true);
    assert.equal(enabled?.enabled, true);
    assert.equal(enabled?.state.nextRunAtMs, job.schedule.kind === "at" ? job.schedule.atMs : enabled?.state.nextRunAtMs);

    const longName = "x".repeat(60);
    const renamed = await service.rename(job.id, longName);
    assert.equal(renamed?.name, `${"x".repeat(48)}…`);

    assert.equal(await service.remove(job.id), true);
    assert.equal(await service.remove(job.id), false);
    assert.equal(service.status(7).totalJobs, 0);
  });

  test("runs every jobs manually and records successful executor state", async () => {
    const service = createService();
    const contexts: CronExecuteContext[] = [];
    service.setExecutor(async (ctx) => {
      contexts.push(ctx);
      return { ok: true };
    });

    const job = await service.create({
      chatId: 42,
      prompt: "manual every",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
    });

    assert.equal(await service.runNow(job.id), true);
    const updated = await waitFor(() => service.get(job.id), (value) => value.state.lastStatus === "ok");

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].source, "manual");
    assert.equal(contexts[0].job.id, job.id);
    assert.equal(updated.state.runningRunId, undefined);
    assert.equal(updated.state.lastError, "");
    assert.equal(updated.state.consecutiveFailures, 0);
    assert.ok(updated.state.lastDurationMs !== undefined);
    assert.ok(updated.state.nextRunAtMs > Date.now());
  });

  test("manual runs of disabled every jobs do not schedule a next run", async () => {
    const service = createService();
    service.setExecutor(async () => ({ ok: true }));
    const job = await service.create({
      chatId: 43,
      prompt: "manual disabled every",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
    });
    await service.setEnabled(job.id, false);

    assert.equal(await service.runNow(job.id), true);
    const updated = await waitFor(() => service.get(job.id), (value) => value.state.lastStatus === "ok");

    assert.equal(updated.enabled, false);
    assert.equal(updated.state.nextRunAtMs, 0);
    assert.equal(updated.state.lastError, "");
  });

  test("retries failed one-shot jobs and disables them after retry budget is exhausted", async () => {
    const service = createService();
    service.setExecutor(async () => ({ ok: false, error: "boom" }));

    const job = await service.create({
      chatId: 9,
      prompt: "fail once",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      policy: { retryMax: 1, retryBackoffMs: 1000, deleteAfterRun: true },
    });

    assert.equal(await service.runNow(job.id), true);
    const afterFirst = await waitFor(() => service.get(job.id), (value) => value.state.consecutiveFailures === 1);
    assert.equal(afterFirst.enabled, true);
    assert.equal(afterFirst.state.lastStatus, "error");
    assert.equal(afterFirst.state.lastError, "boom");
    assert.ok(afterFirst.state.nextRunAtMs > Date.now());

    assert.equal(await service.runNow(job.id), true);
    const afterSecond = await waitFor(() => service.get(job.id), (value) => value.state.consecutiveFailures === 2);
    assert.equal(afterSecond.enabled, false);
    assert.equal(afterSecond.state.nextRunAtMs, 0);
  });

  test("loads persisted jobs and recovers dangling runs on start", async () => {
    const storePath = tempStorePath();
    const now = Date.now();
    const rawJob: CronJobRecord = {
      id: "dangling1",
      botName: "old-bot",
      chatId: 77,
      name: "dangling",
      prompt: "recover me",
      enabled: true,
      createdAtMs: now - 10_000,
      updatedAtMs: now - 5_000,
      schedule: { kind: "at", atMs: now + 60_000 },
      policy: defaultPolicy,
      state: {
        nextRunAtMs: now + 60_000,
        runningRunId: "previous-run",
        runningAtMs: now - 5_000,
        consecutiveFailures: 2,
      },
    };
    writeFileSync(storePath, `${JSON.stringify({ version: 1, updatedAtMs: now, jobs: [rawJob] }, null, 2)}\n`, "utf-8");

    const service = createService({ storePath, enabled: false });
    await service.start();

    const recovered = service.get("dangling1");
    assert.equal(recovered?.state.runningRunId, undefined);
    assert.equal(recovered?.state.runningAtMs, undefined);
    assert.equal(recovered?.state.lastStatus, "error");
    assert.match(recovered?.state.lastError ?? "", /上次进程异常退出/);
    assert.equal(recovered?.state.consecutiveFailures, 3);
    assert.equal(readStore(storePath).jobs[0].state.runningRunId, undefined);

    await service.stop();
  });

  test("ignores malformed persisted stores on start", async () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, "{not json", "utf-8");

    const service = createService({ storePath, enabled: false });
    await service.start();

    assert.deepEqual(service.list(), []);
    assert.equal(service.status().totalJobs, 0);

    await service.stop();
  });

  test("normalizes messy persisted job records on start", async () => {
    const storePath = tempStorePath();
    const now = Date.now();
    writeFileSync(storePath, `${JSON.stringify({
      version: 1,
      updatedAtMs: now,
      jobs: [{
        id: "  messy1  ",
        botName: "legacy-bot",
        chatId: "42",
        name: "  messy\nname\tvalue  ",
        prompt: "  run diagnostics  ",
        enabled: "yes",
        createdAtMs: "1234.9",
        updatedAtMs: "2345.9",
        schedule: { kind: "every", everyMs: "1500.9", anchorMs: "1000.9" },
        policy: { maxLatenessMs: "bad", retryMax: "2.9", retryBackoffMs: "500", deleteAfterRun: 0 },
        state: {
          nextRunAtMs: "0",
          runningAtMs: "3333.9",
          lastRunAtMs: "4444.9",
          lastStatus: "ignored",
          lastError: 123,
          lastDurationMs: "55.9",
          consecutiveFailures: "-2",
        },
      }],
    }, null, 2)}\n`, "utf-8");

    const service = createService({ storePath, enabled: false });
    await service.start();

    const job = service.get("messy1");
    assert.ok(job);
    assert.equal(job.botName, "legacy-bot");
    assert.equal(job.chatId, 42);
    assert.equal(job.name, "messy name value");
    assert.equal(job.prompt, "run diagnostics");
    assert.equal(job.enabled, true);
    assert.equal(job.createdAtMs, 1234);
    assert.equal(job.updatedAtMs, 2345);
    assert.deepEqual(job.schedule, { kind: "every", everyMs: 1500, anchorMs: 1000 });
    assert.deepEqual(job.policy, { ...defaultPolicy, retryMax: 2, deleteAfterRun: false });
    assert.ok(job.state.nextRunAtMs > now);
    assert.equal(job.state.runningRunId, undefined);
    assert.equal(job.state.runningAtMs, 3333);
    assert.equal(job.state.lastRunAtMs, 4444);
    assert.equal(job.state.lastStatus, undefined);
    assert.equal(job.state.lastError, "");
    assert.equal(job.state.lastDurationMs, 55);
    assert.equal(job.state.consecutiveFailures, 0);

    await service.stop();
  });

  test("skips invalid persisted jobs while loading valid records", async () => {
    const storePath = tempStorePath();
    const now = Date.now();
    writeFileSync(storePath, `${JSON.stringify({
      version: 1,
      updatedAtMs: now,
      jobs: [
        { id: "", chatId: 1, prompt: "missing id", schedule: { kind: "at", atMs: now + 60_000 } },
        { id: "bad-chat", chatId: 1.5, prompt: "bad chat", schedule: { kind: "at", atMs: now + 60_000 } },
        { id: "bad-schedule", chatId: 2, prompt: "bad schedule", schedule: { kind: "every", everyMs: 1 } },
        { id: "valid", chatId: 3, prompt: "valid", schedule: { kind: "at", atMs: now + 60_000 } },
      ],
    }, null, 2)}\n`, "utf-8");

    const service = createService({ storePath, enabled: false });
    await service.start();

    assert.deepEqual(service.list().map((job) => job.id), ["valid"]);
    assert.equal(service.status().totalJobs, 1);

    await service.stop();
  });

  test("marks overdue one-shot jobs as missed during enabled startup", async () => {
    const storePath = tempStorePath();
    const now = Date.now();
    const rawJob: CronJobRecord = {
      id: "missed1",
      botName: "test-bot",
      chatId: 88,
      name: "missed",
      prompt: "too late",
      enabled: true,
      createdAtMs: now - 20_000,
      updatedAtMs: now - 20_000,
      schedule: { kind: "at", atMs: now - 10_000 },
      policy: { ...defaultPolicy, maxLatenessMs: 1 },
      state: {
        nextRunAtMs: now - 10_000,
        consecutiveFailures: 0,
      },
    };
    writeFileSync(storePath, `${JSON.stringify({ version: 1, updatedAtMs: now, jobs: [rawJob] }, null, 2)}\n`, "utf-8");

    const service = createService({ storePath, enabled: true });
    await service.start();

    const missed = service.get("missed1");
    assert.equal(missed?.enabled, false);
    assert.equal(missed?.state.nextRunAtMs, 0);
    assert.equal(missed?.state.lastStatus, "missed");
    assert.match(missed?.state.lastError ?? "", /超过允许延迟窗口/);

    await service.stop();
  });

  test("computes next run for cron expression jobs on enabled startup", async () => {
    const storePath = tempStorePath();
    const now = Date.now();
    const rawJob: CronJobRecord = {
      id: "cron1",
      botName: "test-bot",
      chatId: 89,
      name: "cron job",
      prompt: "run hourly",
      enabled: true,
      createdAtMs: now - 20_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "cron", expr: "0 * * * * *", timezone: "UTC" },
      policy: defaultPolicy,
      state: {
        nextRunAtMs: 0,
        consecutiveFailures: 0,
      },
    };
    writeFileSync(storePath, `${JSON.stringify({ version: 1, updatedAtMs: now, jobs: [rawJob] }, null, 2)}\n`, "utf-8");

    const service = createService({ storePath, enabled: true });
    await service.start();

    const scheduled = service.get("cron1");
    assert.equal(scheduled?.enabled, true);
    assert.equal(scheduled?.schedule.kind, "cron");
    assert.equal(scheduled?.schedule.timezone, "UTC");
    assert.ok((scheduled?.state.nextRunAtMs ?? 0) > Date.now());
    assert.equal(service.status(89).nextRunAtMs, scheduled?.state.nextRunAtMs);

    await service.stop();
  });

  test("disables invalid cron expressions during enabled startup", async () => {
    const storePath = tempStorePath();
    const now = Date.now();
    const rawJob: CronJobRecord = {
      id: "bad-cron1",
      botName: "test-bot",
      chatId: 90,
      name: "bad cron",
      prompt: "bad cron",
      enabled: true,
      createdAtMs: now - 20_000,
      updatedAtMs: now - 10_000,
      schedule: { kind: "cron", expr: "not a cron", timezone: "UTC" },
      policy: defaultPolicy,
      state: {
        nextRunAtMs: 0,
        consecutiveFailures: 0,
      },
    };
    writeFileSync(storePath, `${JSON.stringify({ version: 1, updatedAtMs: now, jobs: [rawJob] }, null, 2)}\n`, "utf-8");

    const service = createService({ storePath, enabled: true });
    await service.start();

    const disabled = service.get("bad-cron1");
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.state.nextRunAtMs, 0);
    assert.equal(disabled?.state.lastStatus, "error");
    assert.match(disabled?.state.lastError ?? "", /cron 表达式无效/);

    await service.stop();
  });

  test("deletes successful one-shot jobs when policy requests deleteAfterRun", async () => {
    const service = createService();
    service.setExecutor(async () => ({ ok: true }));
    const job = await service.create({
      chatId: 91,
      prompt: "run once",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
      policy: { deleteAfterRun: true },
    });

    assert.equal(await service.runNow(job.id), true);
    await waitFor(() => service.status(91), (status) => status.totalJobs === 0);

    assert.equal(service.get(job.id), undefined);
  });

  test("records thrown executor errors on recurring jobs", async () => {
    const service = createService();
    service.setExecutor(async () => {
      throw new Error("executor exploded");
    });
    const job = await service.create({
      chatId: 92,
      prompt: "throwing recurring job",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
    });

    assert.equal(await service.runNow(job.id), true);
    const updated = await waitFor(() => service.get(job.id), (value) => value.state.lastStatus === "error");

    assert.equal(updated.enabled, true);
    assert.equal(updated.state.lastError, "executor exploded");
    assert.equal(updated.state.consecutiveFailures, 1);
    assert.ok(updated.state.nextRunAtMs > Date.now());
  });

  test("records executor timeouts using an injectable short timeout", async () => {
    const service = createService({ executorTimeoutMs: 10 });
    service.setExecutor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    });
    const job = await service.create({
      chatId: 93,
      prompt: "slow recurring job",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
    });

    assert.equal(await service.runNow(job.id), true);
    const updated = await waitFor(() => service.get(job.id), (value) => value.state.lastStatus === "error");

    assert.match(updated.state.lastError ?? "", /任务执行超时/);
    assert.equal(updated.state.consecutiveFailures, 1);
  });

  test("lists enabled jobs first by next run and filters by chat", async () => {
    const service = createService({ maxJobsPerChat: 10 });
    const now = Date.now();
    const later = await service.create({ chatId: 1, prompt: "later", schedule: { kind: "at", atMs: now + 30_000 } });
    const earlier = await service.create({ chatId: 1, prompt: "earlier", schedule: { kind: "at", atMs: now + 10_000 } });
    const otherChat = await service.create({ chatId: 2, prompt: "other chat", schedule: { kind: "at", atMs: now + 5_000 } });

    await service.setEnabled(earlier.id, false);

    assert.deepEqual(service.list(1).map((job) => job.id), [later.id, earlier.id]);
    assert.deepEqual(service.list().map((job) => job.id), [otherChat.id, later.id, earlier.id]);
  });

  test("reports running and queued jobs while executor is blocked", async () => {
    const service = createService({ maxJobsPerChat: 10 });
    const releases: Array<() => void> = [];
    service.setExecutor(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const first = await service.create({ chatId: 94, prompt: "first blocked", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });
    const second = await service.create({ chatId: 94, prompt: "second queued", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });

    assert.equal(await service.runNow(first.id), true);
    await waitFor(() => service.status(94), (status) => status.runningJobs === 1);
    assert.equal(await service.runNow(second.id), true);
    await waitFor(() => service.status(94), (status) => status.runningJobs === 1 && status.queuedJobs === 1);

    releases.shift()?.();
    await waitFor(() => service.status(94), (status) => status.runningJobs === 1 && status.queuedJobs === 0);
    releases.shift()?.();
    await waitFor(() => service.status(94), (status) => status.runningJobs === 0 && status.queuedJobs === 0);
  });

  test("removing a queued job clears it from the status queue", async () => {
    const service = createService({ maxJobsPerChat: 10 });
    const releases: Array<() => void> = [];
    service.setExecutor(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const running = await service.create({ chatId: 95, prompt: "running", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });
    const queued = await service.create({ chatId: 95, prompt: "queued", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });

    assert.equal(await service.runNow(running.id), true);
    await waitFor(() => service.status(95), (status) => status.runningJobs === 1);
    assert.equal(await service.runNow(queued.id), true);
    await waitFor(() => service.status(95), (status) => status.queuedJobs === 1);

    assert.equal(await service.remove(queued.id), true);
    assert.equal(service.status(95).queuedJobs, 0);

    releases.shift()?.();
    await waitFor(() => service.status(95), (status) => status.runningJobs === 0);
  });

  test("stop clears queued runs while waiting for the active run", async () => {
    const service = createService({ maxJobsPerChat: 10 });
    const releases: Array<() => void> = [];
    service.setExecutor(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true };
    });
    const running = await service.create({ chatId: 96, prompt: "running during stop", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });
    const queued = await service.create({ chatId: 96, prompt: "queued during stop", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });

    assert.equal(await service.runNow(running.id), true);
    await waitFor(() => service.status(96), (status) => status.runningJobs === 1);
    assert.equal(await service.runNow(queued.id), true);
    await waitFor(() => service.status(96), (status) => status.queuedJobs === 1);

    const stopped = service.stop();
    await waitFor(() => service.status(96), (status) => status.queuedJobs === 0);
    releases.shift()?.();
    await stopped;

    assert.equal(service.status(96).runningJobs, 0);
    assert.equal(service.get(queued.id)?.state.lastStatus, undefined);
  });

  test("runNow returns false for unknown jobs", async () => {
    const service = createService();

    assert.equal(await service.runNow("missing-job"), false);
    assert.equal(service.status().queuedJobs, 0);
  });

  test("runNow returns false when the job is already running", async () => {
    const service = createService();
    let release: (() => void) | undefined;
    service.setExecutor(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true };
    });
    const job = await service.create({ chatId: 97, prompt: "already running", schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } });

    assert.equal(await service.runNow(job.id), true);
    await waitFor(() => service.status(97), (status) => status.runningJobs === 1);
    assert.equal(await service.runNow(job.id), false);
    assert.equal(service.status(97).queuedJobs, 0);

    release?.();
    await waitFor(() => service.status(97), (status) => status.runningJobs === 0);
  });

  test("rejects invalid schedule shapes", async () => {
    const service = createService();

    await assert.rejects(
      () => service.create({ chatId: 1, prompt: "missing schedule", schedule: undefined as never }),
      /缺少 schedule/,
    );
    await assert.rejects(
      () => service.create({ chatId: 1, prompt: "too frequent", schedule: { kind: "every", everyMs: 999, anchorMs: Date.now() } }),
      /everyMs 不能小于 1000ms/,
    );
    await assert.rejects(
      () => service.create({ chatId: 1, prompt: "unknown", schedule: { kind: "daily" } as never }),
      /未知 schedule.kind: daily/,
    );
  });
});
