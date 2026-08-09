import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { Bot } from "grammy";
import { CommandGroup } from "@grammyjs/commands";
import { createCronFeatures } from "../../src/telegram/cron.js";

// @covers telegram/cron.ts

describe("Telegram cron feature", () => {
  test("installs its command/menu boundary and exposes prompt hooks", async () => {
    const bot = new Bot("123456:TEST_TOKEN");
    const commandGroup = new CommandGroup();
    let executor: unknown;
    let middlewareRegistrations = 0;

    const features = createCronFeatures({
      bot: {
        api: bot.api,
        use: () => { middlewareRegistrations += 1; },
      } as never,
      botIndex: 0,
      botKey: "abc",
      pool: {} as never,
      cron: {
        setExecutor: (value: unknown) => { executor = value; },
        list: () => [],
      } as never,
      commandGroup,
      maxResponseLength: 4000,
    });

    assert.equal(typeof executor, "function");
    assert.equal(middlewareRegistrations, 1);
    assert.equal(await features.consumePendingInput({ chat: { id: 1 } } as never, "hello"), false);
    assert.deepEqual(await features.applyToolDirectives({ chat: { id: 1 } } as never, "plain"), {
      text: "plain",
      warnings: [],
    });
    assert.deepEqual(await features.applyToolDirectives({ chat: { id: 1 } } as never, '<tg-cron action="list" />'), {
      text: "⏰ 当前聊天暂无定时任务。",
      warnings: [],
    });
  });
});
