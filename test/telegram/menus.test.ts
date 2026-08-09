import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createBotMenus } from "../../src/telegram/menus.js";
import type { AgentPool } from "../../src/agent.js";
import type { PiModelInfo } from "../../src/types.js";

// @covers telegram/menu.ts

class FakePiInstance {
  getAvailableModelsCalls = 0;
  getStateCalls = 0;
  getAvailableThinkingLevelsCalls = 0;
  setModelCalls: Array<[string, string]> = [];
  setThinkingLevelCalls: string[] = [];
  failState = false;
  thinkingLevels?: string[];

  constructor(
    public models: PiModelInfo[] = [],
    public state: Record<string, unknown> = {},
    thinkingLevels?: string[],
  ) {
    this.thinkingLevels = thinkingLevels;
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    this.getAvailableModelsCalls += 1;
    return this.models;
  }

  async getState(): Promise<Record<string, unknown>> {
    this.getStateCalls += 1;
    if (this.failState) throw new Error("state unavailable");
    return this.state;
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    this.getAvailableThinkingLevelsCalls += 1;
    if (!this.thinkingLevels) throw new Error("thinking levels unavailable");
    return this.thinkingLevels;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.setModelCalls.push([provider, modelId]);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.setThinkingLevelCalls.push(level);
  }
}

class FakePool {
  keys: string[] = [];

  constructor(private readonly instances: Record<string, FakePiInstance>) {}

  get(key: string): FakePiInstance {
    this.keys.push(key);
    const inst = this.instances[key];
    if (!inst) throw new Error(`missing fake instance for ${key}`);
    return inst;
  }
}

function asPool(pool: FakePool): AgentPool {
  return pool as unknown as AgentPool;
}

describe("bot menu state", () => {
  test("initializes stream mode from persisted per-chat settings and defaults to enabled", () => {
    const menus = createBotMenus({
      botIndex: 0,
      botKey: "abc",
      pool: asPool(new FakePool({})),
      initialStreamByChat: {
        "100": false,
        "200": true,
        bad: false,
      },
    });

    assert.equal(menus.isStreamEnabled(100), false);
    assert.equal(menus.isStreamEnabled(200), true);
    assert.equal(menus.isStreamEnabled(300), true);
  });

  test("refreshes models for a chat and syncs current model and thinking level", async () => {
    const key = "botabc_chat42";
    const inst = new FakePiInstance(
      [
        { id: "fast", name: "Fast", provider: "open", reasoning: true },
        { id: "deep", name: "Deep", provider: "open", reasoning: true },
      ],
      { model: { provider: "open", id: "deep", reasoning: false }, thinkingLevel: "medium" },
    );
    const pool = new FakePool({ [key]: inst });
    const menus = createBotMenus({ botIndex: 1, botKey: "abc", pool: asPool(pool) });

    const models = await menus.refreshModelsForChat(42);

    assert.deepEqual(models.map((model) => model.id), ["fast", "deep"]);
    assert.deepEqual(pool.keys, [key]);
    assert.equal(inst.getAvailableModelsCalls, 1);
    assert.equal(inst.getStateCalls, 1);
    assert.equal(await menus.ensureThinkingForChat(42), "medium");
    assert.equal(await menus.supportsThinkingForChat(42), false);
  });

  test("uses model-specific thinking levels and invalidates them after a model change", async () => {
    const key = "botlevels_chat8";
    const inst = new FakePiInstance(
      [{ id: "m", name: "Model", provider: "p", reasoning: true }],
      { model: { provider: "p", id: "m", reasoning: true }, thinkingLevel: "low" },
      ["off", "low", "max"],
    );
    const pool = new FakePool({ [key]: inst });
    const menus = createBotMenus({ botIndex: 8, botKey: "levels", pool: asPool(pool) });

    assert.deepEqual(await menus.ensureThinkingLevelsForChat(8), ["off", "low", "max"]);
    assert.equal(await menus.supportsThinkingForChat(8), true);
    assert.equal(inst.getAvailableThinkingLevelsCalls, 1);

    menus.syncState(8, { model: { provider: "p", id: "other" } });
    assert.deepEqual(await menus.ensureThinkingLevelsForChat(8), ["off", "low", "max"]);
    assert.equal(inst.getAvailableThinkingLevelsCalls, 2);
  });

  test("treats an off-only capability response as no thinking support", async () => {
    const key = "botoff_chat3";
    const inst = new FakePiInstance(
      [{ id: "plain", name: "Plain", provider: "p", reasoning: false }],
      { model: { provider: "p", id: "plain", reasoning: false }, thinkingLevel: "off" },
      ["off"],
    );
    const pool = new FakePool({ [key]: inst });
    const menus = createBotMenus({ botIndex: 9, botKey: "off", pool: asPool(pool) });

    assert.deepEqual(await menus.ensureThinkingLevelsForChat(3), ["off"]);
    assert.equal(await menus.supportsThinkingForChat(3), false);
  });

  test("uses cached thinking level populated by syncState without touching the pool", async () => {
    const pool = new FakePool({});
    const menus = createBotMenus({ botIndex: 2, botKey: "cache", pool: asPool(pool) });

    menus.syncState(7, {
      model: { provider: "p", id: "m" },
      thinkingLevel: "high",
    });

    assert.equal(await menus.ensureThinkingForChat(7), "high");
    assert.deepEqual(pool.keys, []);
  });

  test("falls back to cached model metadata when state lacks a reasoning flag", async () => {
    const key = "botmeta_chat9";
    const inst = new FakePiInstance(
      [
        { id: "plain", name: "Plain", provider: "local", reasoning: false },
        { id: "reasoning", name: "Reasoning", provider: "local", reasoning: true },
      ],
      { model: { provider: "local", id: "plain" }, thinkingLevel: "low" },
    );
    const pool = new FakePool({ [key]: inst });
    const menus = createBotMenus({ botIndex: 3, botKey: "meta", pool: asPool(pool) });

    await menus.refreshModelsForChat(9);

    assert.equal(await menus.supportsThinkingForChat(9), false);
  });

  test("returns safe defaults when state and model refresh fail", async () => {
    const key = "botfail_chat5";
    const inst = new FakePiInstance([], {});
    inst.failState = true;
    const pool = new FakePool({ [key]: inst });
    const menus = createBotMenus({ botIndex: 4, botKey: "fail", pool: asPool(pool) });

    assert.equal(await menus.ensureThinkingForChat(5), "");
    assert.equal(await menus.supportsThinkingForChat(5), true);
    assert.ok(inst.getStateCalls >= 2);
  });
});
