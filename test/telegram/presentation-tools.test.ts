import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { AiToolRegistry, getRegisteredToolSystemPrompt } from "../../src/telegram/presentation.js";

// @covers telegram/tool-prompt.ts

describe("AI tool prompt registry", () => {
  test("renders empty registry as empty prompt", () => {
    assert.equal(new AiToolRegistry().renderInstructions(), "");
  });

  test("renders registered tools in order", () => {
    const prompt = new AiToolRegistry()
      .register({ name: "first", instructions: "Use first." })
      .register({ name: "second", instructions: "Use second." })
      .renderInstructions();

    assert.match(prompt, /^你可以使用以下桥接工具协议/);
    assert.match(prompt, /# 工具 1: first\nUse first\./);
    assert.match(prompt, /# 工具 2: second\nUse second\./);
    assert.ok(prompt.indexOf("# 工具 1: first") < prompt.indexOf("# 工具 2: second"));
    assert.match(prompt, /如果无需调用工具，直接正常回答。$/);
  });

  test("default prompt documents reply, attachment, and cron protocols", () => {
    const prompt = getRegisteredToolSystemPrompt();

    assert.match(prompt, /tg-reply/);
    assert.match(prompt, /tg-attachment/);
    assert.match(prompt, /tg-cron/);
    assert.match(prompt, /不要把标签包在 markdown 代码块里/);
  });
});
