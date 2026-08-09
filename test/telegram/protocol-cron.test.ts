import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { extractTgCronDirectives } from "../../src/telegram/protocol.js";

// @covers telegram/protocol.ts

describe("tg-cron directives", () => {
  test("extracts add every directives with aliases and body prompt", () => {
    const result = extractTgCronDirectives(
      'Before <tg-cron cmd="create" schedule="interval" every="10m" title="巡检">检查报警</tg-cron> after',
    );

    assert.equal(result.text, "Before  after");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.directives, [
      {
        action: "add",
        kind: "every",
        name: "巡检",
        prompt: "检查报警",
        at: undefined,
        every: "10m",
        expr: undefined,
        timezone: undefined,
      },
    ]);
  });

  test("extracts list, stat, id-based, and rename directives", () => {
    const result = extractTgCronDirectives([
      '<tg-cron action="list" />',
      '<tg-cron action="status" />',
      '<tg-cron action="off" job-id="abc123" />',
      '<tg-cron action="rename" id="abc123">新名称</tg-cron>',
    ].join("\n"));

    assert.equal(result.directives.length, 4);
    assert.deepEqual(result.directives[0], { action: "list" });
    assert.deepEqual(result.directives[1], { action: "stat" });
    assert.deepEqual(result.directives[2], { action: "off", id: "abc123" });
    assert.deepEqual(result.directives[3], { action: "rename", id: "abc123", name: "新名称" });
    assert.deepEqual(result.warnings, []);
  });

  test("validates required fields and keeps plain text", () => {
    const result = extractTgCronDirectives([
      "hello",
      '<tg-cron action="add" kind="at" prompt="missing time" />',
      '<tg-cron action="run" />',
      '<tg-cron action="unknown" />',
      "world",
    ].join("\n"));

    assert.equal(result.text, "hello\n\nworld");
    assert.deepEqual(result.directives, []);
    assert.match(result.warnings.join("\n"), /kind=at 缺少 at/);
    assert.match(result.warnings.join("\n"), /action=run 缺少 id/);
    assert.match(result.warnings.join("\n"), /缺少或不支持 action/);
  });

  test("limits processed directives to the first eight", () => {
    const input = Array.from({ length: 10 }, (_, i) => `<tg-cron action="list" data-i="${i}" />`).join("\n");
    const result = extractTgCronDirectives(input);

    assert.equal(result.directives.length, 8);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => warning.includes("仅处理前 8 条")));
  });

  test("extracts add at and cron directives with attribute prompt aliases", () => {
    const result = extractTgCronDirectives([
      '<tg-cron action="new" kind="one-shot" at="2026-01-01T00:00:00Z" message="wake up" />',
      '<tg-cron op="add" kind="cron" cron="0 9 * * *" tz="Asia/Shanghai" task="daily" title="日报" />',
    ].join("\n"));

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.directives, [
      {
        action: "add",
        kind: "at",
        name: undefined,
        prompt: "wake up",
        at: "2026-01-01T00:00:00Z",
        every: undefined,
        expr: undefined,
        timezone: undefined,
      },
      {
        action: "add",
        kind: "cron",
        name: "日报",
        prompt: "daily",
        at: undefined,
        every: undefined,
        expr: "0 9 * * *",
        timezone: "Asia/Shanghai",
      },
    ]);
  });

  test("warns for missing add prompt, every, cron expr, and rename name", () => {
    const result = extractTgCronDirectives([
      '<tg-cron action="add" kind="every" prompt="missing interval" />',
      '<tg-cron action="add" kind="cron">missing expr</tg-cron>',
      '<tg-cron action="add" kind="every" every="5m" />',
      '<tg-cron action="rename" id="abc" />',
    ].join("\n"));

    assert.deepEqual(result.directives, []);
    assert.match(result.warnings.join("\n"), /kind=every 缺少 every/);
    assert.match(result.warnings.join("\n"), /kind=cron 缺少 expr/);
    assert.match(result.warnings.join("\n"), /add 缺少 prompt/);
    assert.match(result.warnings.join("\n"), /rename 缺少 name/);
  });
});
