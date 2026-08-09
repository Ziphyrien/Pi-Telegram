import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AppConfig, BotConfig, CronConfig } from "../src/types.js";
import type {
  CronCreateInput,
  CronExecuteContext,
  CronExecuteResult,
  CronJobPolicy,
  CronJobRecord,
  CronSchedule,
  SchedulerOptions,
  CronStoreData,
} from "../src/types.js";
import type { PiContextUsage, PiImage, PiModelInfo, PiSessionStats, PiTokenStats } from "../src/types.js";

// @covers types.ts

describe("public type contracts", () => {
  test("accepts the documented application config shape", () => {
    const bot = {
      token: "token",
      name: "Pi-Telegram",
      allowedUsers: [123, "alice"],
      cwd: "/tmp/workspace",
      streamByChat: { "123": true },
    } satisfies BotConfig;

    const cron = {
      enabled: true,
      defaultTimezone: "UTC",
      maxJobsPerChat: 20,
      maxRunSeconds: 900,
      maxLatenessMs: 60_000,
      retryMax: 2,
      retryBackoffMs: 30_000,
    } satisfies CronConfig;

    const app = {
      bots: [bot],
      idleTimeoutMs: 600_000,
      maxResponseLength: 4000,
      lastChangelogVersion: "1.2.3",
      cron,
    } satisfies AppConfig;

    assert.equal(app.bots[0].allowedUsers[0], 123);
    assert.equal(app.cron?.defaultTimezone, "UTC");
  });

  test("accepts cron schedule, job, store, executor, and service option shapes", async () => {
    const schedule = { kind: "every", everyMs: 60_000, anchorMs: 1_700_000_000_000 } satisfies CronSchedule;
    const policy = { maxLatenessMs: 1, retryMax: 2, retryBackoffMs: 1000, deleteAfterRun: true } satisfies CronJobPolicy;
    const job = {
      id: "job1",
      botName: "bot",
      chatId: 42,
      name: "Daily",
      prompt: "summarize",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule,
      policy,
      state: {
        nextRunAtMs: 3,
        consecutiveFailures: 0,
      },
    } satisfies CronJobRecord;
    const store = { version: 1, jobs: [job], updatedAtMs: 4 } satisfies CronStoreData;
    const createInput = { chatId: 42, prompt: "summarize", schedule } satisfies CronCreateInput;
    const serviceOptions = {
      storePath: "/tmp/jobs.json",
      botName: "bot",
      enabled: true,
      defaultTimezone: "UTC",
      maxJobsPerChat: 20,
      maxRunMs: 900_000,
      defaultPolicy: policy,
    } satisfies SchedulerOptions;
    const context = { job, runId: "run1", source: "manual", scheduledAtMs: 5 } satisfies CronExecuteContext;
    const result = { ok: false, error: "boom" } satisfies CronExecuteResult;

    const executor = async (ctx: CronExecuteContext): Promise<CronExecuteResult> => ({ ok: ctx.source === "manual" });

    assert.equal(store.jobs[0].schedule.kind, "every");
    assert.equal(createInput.schedule.kind, "every");
    assert.equal(serviceOptions.defaultPolicy.retryMax, 2);
    assert.equal(context.source, "manual");
    assert.equal(result.error, "boom");
    assert.deepEqual(await executor(context), { ok: true });
  });

  test("accepts pi image, model, token, context, and session stats shapes", () => {
    const image = { type: "image", data: "base64", mimeType: "image/png" } satisfies PiImage;
    const model = { id: "m1", name: "Model", provider: "provider", reasoning: true, contextWindow: 128_000 } satisfies PiModelInfo;
    const tokens = { total: 10, input: 3, output: 7, cacheRead: 1, cacheWrite: 2 } satisfies PiTokenStats;
    const contextUsage = { tokens: 10, contextWindow: 128_000, percent: 0.01 } satisfies PiContextUsage;
    const stats = { cost: 0.01, totalMessages: 2, tokens, contextUsage } satisfies PiSessionStats;

    assert.equal(image.type, "image");
    assert.equal(model.reasoning, true);
    assert.equal(stats.tokens?.cacheWrite, 2);
    assert.equal(stats.contextUsage?.tokens, 10);
  });
});
