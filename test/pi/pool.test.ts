import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiPool } from "../../src/pi/pool.js";
import type { PiRpcOptions } from "../../src/pi/rpc.js";

// @covers pi/pool.ts

class FakeRpc extends EventEmitter {
  alive = true;
  streaming = false;
  lastActivity = Date.now();
  startCalls = 0;
  killCalls = 0;
  removed = false;
  emitExitSynchronously = false;
  suppressExit = false;

  constructor(readonly opts: PiRpcOptions) {
    super();
  }

  start(): void {
    this.startCalls += 1;
  }

  kill(): void {
    this.killCalls += 1;
    this.alive = false;
    if (this.emitExitSynchronously) {
      this.emit("exit", 0);
      return;
    }
    if (this.suppressExit) return;
    setImmediate(() => this.emit("exit", 0));
  }

  override removeAllListeners(eventName?: string | symbol): this {
    this.removed = true;
    return super.removeAllListeners(eventName);
  }
}

function createPool(overrides: Partial<ConstructorParameters<typeof PiPool>[0]> = {}) {
  const created: FakeRpc[] = [];
  const sessionBaseDir = mkdtempSync(join(tmpdir(), "pitg-pool-"));
  const pool = new PiPool({
    cwd: "/workspace",
    piArgs: ["--model", "test"],
    appendSystemPrompt: " /tmp/tool-prompt.txt ",
    sessionBaseDir,
    idleTimeoutMs: 10_000,
    rpcFactory: (opts) => {
      const rpc = new FakeRpc(opts);
      created.push(rpc);
      return rpc as never;
    },
    ...overrides,
  });
  return { pool, created, sessionBaseDir };
}

describe("PiPool", () => {
  test("spawns and reuses alive RPC instances per chat", async () => {
    const { pool, created, sessionBaseDir } = createPool();

    const first = pool.get("chat1") as unknown as FakeRpc;
    const second = pool.get("chat1") as unknown as FakeRpc;

    assert.equal(first, second);
    assert.equal(created.length, 1);
    assert.equal(first.startCalls, 1);
    assert.deepEqual(first.opts.piArgs, ["--model", "test", "--append-system-prompt", "/tmp/tool-prompt.txt"]);
    assert.equal(first.opts.sessionDir, resolve(sessionBaseDir, "chat1"));
    assert.equal(first.opts.continueSession, true);
    assert.equal(pool.has("chat1"), first as never);
    assert.equal(pool.size, 1);

    await pool.shutdown();
  });

  test("does not duplicate append-system-prompt when caller already supplied it", async () => {
    const { pool, created } = createPool({
      piArgs: ["--append-system-prompt", "existing.txt"],
      appendSystemPrompt: "new.txt",
    });

    pool.get("chat2");

    assert.deepEqual(created[0].opts.piArgs, ["--append-system-prompt", "existing.txt"]);
    await pool.shutdown();
  });

  test("spawns a new instance for dead entries and removes old listeners", async () => {
    const { pool, created } = createPool();
    const first = pool.get("chat3") as unknown as FakeRpc;
    first.alive = false;

    const second = pool.get("chat3") as unknown as FakeRpc;

    assert.notEqual(first, second);
    assert.equal(first.removed, true);
    assert.equal(created.length, 2);
    assert.equal(second.opts.continueSession, true);

    await pool.shutdown();
  });

  test("removes current instances from the pool when they exit", async () => {
    const { pool } = createPool();
    const inst = pool.get("exit-cleanup") as unknown as FakeRpc;

    inst.emit("exit", 0);

    assert.equal(pool.has("exit-cleanup"), undefined);
    assert.equal(pool.size, 0);
    await pool.shutdown();
  });

  test("ignores exit events from instances that have already been replaced", async () => {
    const { pool } = createPool();
    const first = pool.get("replaced-exit") as unknown as FakeRpc;
    first.alive = false;
    const second = pool.get("replaced-exit") as unknown as FakeRpc;

    first.emit("exit", 0);

    assert.equal(pool.has("replaced-exit"), second as never);
    assert.equal(pool.size, 1);
    await pool.shutdown();
  });

  test("getFresh kills an alive instance and starts a non-continuing replacement", async () => {
    const { pool, created } = createPool();
    const first = pool.get("chat4") as unknown as FakeRpc;

    const fresh = await pool.getFresh("chat4") as unknown as FakeRpc;

    assert.equal(first.killCalls, 1);
    assert.equal(first.removed, true);
    assert.notEqual(fresh, first);
    assert.equal(created.length, 2);
    assert.equal(fresh.opts.continueSession, false);

    await pool.shutdown();
  });

  test("getFresh observes synchronous exit events from killed instances", async () => {
    const { pool, created } = createPool();
    const first = pool.get("sync-fresh") as unknown as FakeRpc;
    first.emitExitSynchronously = true;

    const result = await Promise.race([
      pool.getFresh("sync-fresh"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout");
    assert.equal(first.killCalls, 1);
    assert.equal(first.removed, true);
    assert.equal(created.length, 2);

    await pool.shutdown();
  });

  test("getFresh times out stuck old instances before replacing them", async () => {
    const { pool, created } = createPool({ shutdownTimeoutMs: 10 });
    const first = pool.get("stuck-fresh") as unknown as FakeRpc;
    first.suppressExit = true;

    const result = await Promise.race([
      pool.getFresh("stuck-fresh"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout");
    assert.equal(first.killCalls, 1);
    assert.equal(first.removed, true);
    assert.equal(created.length, 2);
    assert.equal((result as unknown as FakeRpc).opts.continueSession, false);

    await pool.shutdown();
  });

  test("shutdown kills alive instances and waits for exit", async () => {
    const { pool, created } = createPool();
    const alive = pool.get("alive") as unknown as FakeRpc;
    const dead = pool.get("dead") as unknown as FakeRpc;
    dead.alive = false;

    await pool.shutdown();

    assert.equal(alive.killCalls, 1);
    assert.equal(dead.killCalls, 0);
    assert.equal(created.length, 2);
  });

  test("shutdown observes synchronous exit events from alive instances", async () => {
    const { pool } = createPool();
    const alive = pool.get("sync-shutdown") as unknown as FakeRpc;
    alive.emitExitSynchronously = true;

    const result = await Promise.race([
      pool.shutdown().then(() => "shutdown" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.equal(result, "shutdown");
    assert.equal(alive.killCalls, 1);
  });

  test("shutdown times out stuck instances and clears the pool", async () => {
    const { pool } = createPool({ shutdownTimeoutMs: 10 });
    const stuck = pool.get("stuck-shutdown") as unknown as FakeRpc;
    stuck.suppressExit = true;

    const result = await Promise.race([
      pool.shutdown().then(() => "shutdown" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.equal(result, "shutdown");
    assert.equal(stuck.killCalls, 1);
    assert.equal(pool.size, 0);
  });

  test("reaps idle alive non-streaming instances", async () => {
    const { pool } = createPool({ idleTimeoutMs: 100 });
    const idle = pool.get("idle") as unknown as FakeRpc;
    const fresh = pool.get("fresh") as unknown as FakeRpc;
    const streaming = pool.get("streaming") as unknown as FakeRpc;
    idle.lastActivity = Date.now() - 1_000;
    fresh.lastActivity = Date.now();
    streaming.lastActivity = Date.now() - 1_000;
    streaming.streaming = true;

    (pool as unknown as { reap: () => void }).reap();

    assert.equal(idle.killCalls, 1);
    assert.equal(fresh.killCalls, 0);
    assert.equal(streaming.killCalls, 0);

    await pool.shutdown();
  });

  test("does not reap dead or recently active instances", async () => {
    const { pool } = createPool({ idleTimeoutMs: 100 });
    const dead = pool.get("dead-idle") as unknown as FakeRpc;
    const recent = pool.get("recent") as unknown as FakeRpc;
    dead.alive = false;
    dead.lastActivity = Date.now() - 1_000;
    recent.lastActivity = Date.now();

    (pool as unknown as { reap: () => void }).reap();

    assert.equal(dead.killCalls, 0);
    assert.equal(recent.killCalls, 0);

    await pool.shutdown();
  });
});
