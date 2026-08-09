import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusLines, formatContextUsage, formatCost } from "../../src/telegram/status.js";

// @covers telegram/status.ts

describe("telegram status formatting", () => {
  test("formats costs with precision based on magnitude", () => {
    assert.equal(formatCost(12), "12.00");
    assert.equal(formatCost(0.1234), "0.123");
    assert.equal(formatCost(0.0012), "0.0012");
    assert.equal(formatCost(0.00012), "0.00012");
  });

  test("formats context usage when a context window is available", () => {
    assert.equal(
      formatContextUsage({ tokens: 1234, contextWindow: 10000, percent: 12.34 }),
      "📦 上下文占用: 1,234 / 10,000 (12%)",
    );
    assert.equal(
      formatContextUsage({ tokens: null, contextWindow: 8000, percent: 1.25 }),
      "📦 上下文占用: ? / 8,000 (1.3%)",
    );
    assert.equal(formatContextUsage(undefined), undefined);
  });

  test("builds status lines and omits optional empty fields", () => {
    const lines = buildStatusLines({
      alive: true,
      processing: false,
      providerLabel: "openai",
      modelLabel: "gpt-test",
      streamEnabled: true,
      thinkingLabel: "medium",
      sessionLabel: "abc123",
      cost: 0.01234,
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
      activeCount: 2,
      cron: { enabled: true, totalJobs: 3, enabledJobs: 2 },
    });

    assert.deepEqual(lines, [
      "✅ 运行中 | 🟢 空闲",
      "🏢 供应商: openai",
      "🤖 模型: gpt-test",
      "⚙️ 输出: 流式",
      "🧠 思考: medium",
      "🗂 会话: abc123",
      "💰 花费: $0.012",
      "📦 上下文占用: 100 / 1,000 (10%)",
      "📊 活跃: 2",
      "⏰ 定时: 开启 | 任务 3（启用 2）",
    ]);
  });

  test("builds minimal offline status", () => {
    const lines = buildStatusLines({
      alive: false,
      processing: false,
      modelLabel: "默认",
      streamEnabled: false,
      activeCount: 0,
      cron: { enabled: false, totalJobs: 0, enabledJobs: 0 },
    });

    assert.deepEqual(lines, [
      "💤 未启动 | 🟢 空闲",
      "🤖 模型: 默认",
      "⚙️ 输出: 非流式",
      "📊 活跃: 0",
      "⏰ 定时: 关闭 | 任务 0（启用 0）",
    ]);
  });

  test("formats context usage without percent and with fractional low percent", () => {
    assert.equal(
      formatContextUsage({ tokens: 50, contextWindow: 2000, percent: null }),
      "📦 上下文占用: 50 / 2,000",
    );
    assert.equal(
      formatContextUsage({ tokens: 10, contextWindow: 2000, percent: 0.55 }),
      "📦 上下文占用: 10 / 2,000 (0.6%)",
    );
  });

  test("omits non-positive cost from status lines", () => {
    const lines = buildStatusLines({
      alive: true,
      processing: true,
      modelLabel: "default",
      streamEnabled: true,
      cost: 0,
      activeCount: 1,
      cron: { enabled: true, totalJobs: 0, enabledJobs: 0 },
    });

    assert.equal(lines.some((line) => line.includes("花费")), false);
    assert.equal(lines[0], "✅ 运行中 | ⏳ 处理中");
  });
});
