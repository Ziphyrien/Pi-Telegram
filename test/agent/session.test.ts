import { EventEmitter } from "node:events";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type AgentClient, type AgentClientOptions, type AgentClientEvent } from "../../src/agent.js";

// @covers agent.ts

type PromptHandler = (message: string, images?: unknown) => Promise<void>;

class FakeProcess extends EventEmitter {
  killedSignals: string[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal ?? "SIGTERM");
    this.emit("exit", null);
    return true;
  }
}

type TestProcess = FakeProcess & NonNullable<AgentClient["process"]>;

class FakeClient implements AgentClient {
  readonly process = new FakeProcess() as unknown as TestProcess;
  handlers = new Set<(event: AgentClientEvent) => void>();
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  promptCalls: Array<{ message: string; images?: unknown }> = [];
  stderr = "";
  startError?: Error;
  stopError?: Error;
  autoSettle = true;
  onPrompt: PromptHandler = async () => {
    this.emitEvent({ type: "agent_end", messages: [{ stopReason: "end" }] } as unknown as AgentClientEvent);
  };
  models = [{ id: "m1", name: "Model 1", provider: "p1", reasoning: true }];
  thinkingLevels = ["off", "medium", "high", "max"];
  state: Record<string, unknown> = { model: { provider: "p1", id: "m1" }, thinkingLevel: "medium" };
  stats = { cost: 0.01 };
  setModelCalls: Array<[string, string]> = [];
  setThinkingLevelCalls: unknown[] = [];
  getAvailableThinkingLevelsCalls = 0;

  constructor(readonly opts: AgentClientOptions) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopError) throw this.stopError;
    this.process.emit("exit", 0);
  }

  async prompt(message: string, images?: unknown): Promise<void> {
    this.promptCalls.push({ message, images });
    await this.onPrompt(message, images);
  }

  onEvent(handler: (event: AgentClientEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emitEvent(event: AgentClientEvent): void {
    for (const handler of [...this.handlers]) handler(event);
    if (event.type === "agent_end" && this.autoSettle) {
      for (const handler of [...this.handlers]) handler({ type: "agent_settled" } as unknown as AgentClientEvent);
    }
  }

  getStderr(): string {
    return this.stderr;
  }

  async getAvailableModels() {
    return this.models;
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    this.getAvailableThinkingLevelsCalls += 1;
    return this.thinkingLevels;
  }

  async getState() {
    return this.state;
  }

  async getSessionStats() {
    return this.stats;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.setModelCalls.push([provider, modelId]);
  }

  async setThinkingLevel(level: unknown): Promise<void> {
    this.setThinkingLevelCalls.push(level);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }
}

function createRpc(overrides: Partial<{
  continueSession: boolean;
  killGraceMs: number;
  onClient: (client: FakeClient) => void;
}> = {}) {
  const clients: FakeClient[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "pitg-rpc-session-"));
  const rpc = new AgentSession({
    cwd: "/workspace",
    piArgs: ["--model", "test"],
    sessionDir,
    continueSession: overrides.continueSession ?? true,
    killGraceMs: overrides.killGraceMs,
    clientFactory: (opts) => {
      const client = new FakeClient(opts);
      clients.push(client);
      overrides.onClient?.(client);
      return client;
    },
  });
  return { rpc, clients, sessionDir };
}

async function waitForStarted(rpc: AgentSession): Promise<void> {
  await rpc.getState();
}

describe("AgentSession", () => {
  test("starts a client with session args and creates the session directory", async () => {
    const { rpc, clients, sessionDir } = createRpc();

    rpc.start();
    await waitForStarted(rpc);

    assert.equal(rpc.alive, true);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].startCalls, 1);
    assert.equal(clients[0].opts.cwd, "/workspace");
    assert.ok(clients[0].opts.cliPath.endsWith("cli.js"));
    assert.deepEqual(clients[0].opts.args, ["--session-dir", sessionDir, "-c", "--model", "test"]);
    assert.equal(existsSync(sessionDir), true);
  });

  test("omits continue flag when starting a fresh session", async () => {
    const { rpc, clients, sessionDir } = createRpc({ continueSession: false });

    rpc.start();
    await waitForStarted(rpc);

    assert.deepEqual(clients[0].opts.args, ["--session-dir", sessionDir, "--model", "test"]);
  });

  test("streams text deltas, tool events, and resolves on agent_settled", async () => {
    const { rpc, clients } = createRpc({
      onClient: (client) => {
        client.onPrompt = async () => {
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "tool_execution_start", toolName: "read" } as unknown as AgentClientEvent);
          client.emitEvent({ type: "tool_execution_end", toolName: "read", isError: true } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "agent_end", messages: [{ stopReason: "end" }] } as unknown as AgentClientEvent);
        };
      },
    });
    const deltas: string[] = [];
    const fullTexts: string[] = [];
    const toolStarts: Array<string | undefined> = [];
    const toolErrors: Array<string | undefined> = [];

    rpc.start();
    const result = await rpc.prompt("say hi", [{ type: "image", data: "abc", mimeType: "image/png" }], {
      onStart: () => deltas.push("started"),
      onTextDelta: (delta, full) => {
        deltas.push(delta);
        fullTexts.push(full);
      },
      onToolStart: (toolName) => toolStarts.push(toolName),
      onToolError: (toolName) => toolErrors.push(toolName),
    });

    assert.equal(result.text, "hello world");
    assert.deepEqual(result.tools, ["🔧 read", "  ❌ error"]);
    assert.deepEqual(deltas, ["started", "hello", " world"]);
    assert.deepEqual(fullTexts, ["hello", "hello world"]);
    assert.deepEqual(toolStarts, ["read"]);
    assert.deepEqual(toolErrors, ["read"]);
    assert.equal(rpc.streaming, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rpc.running, false);
    assert.equal(clients[0].promptCalls[0].message, "say hi");
  });

  test("waits for agent_settled and keeps only the retried final response", async () => {
    let releaseSettled!: () => void;
    const settledGate = new Promise<void>((resolve) => {
      releaseSettled = resolve;
    });
    const { rpc, clients } = createRpc({
      onClient: (client) => {
        client.autoSettle = false;
        client.onPrompt = async () => {
          client.emitEvent({ type: "agent_start" } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_start", message: { role: "assistant" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } } as unknown as AgentClientEvent);
          client.emitEvent({
            type: "agent_end",
            messages: [{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "retrying" }] }],
            willRetry: true,
          } as unknown as AgentClientEvent);

          client.emitEvent({ type: "agent_start" } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_start", message: { role: "assistant" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fin" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } } as unknown as AgentClientEvent);
          client.emitEvent({
            type: "agent_end",
            messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final" }] }],
            willRetry: false,
          } as unknown as AgentClientEvent);

          await settledGate;
          client.emitEvent({ type: "agent_settled" } as unknown as AgentClientEvent);
        };
      },
    });

    rpc.start();
    const prompt = rpc.prompt("retry");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rpc.streaming, true);

    let completed = false;
    void prompt.then(() => { completed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);

    releaseSettled();
    assert.deepEqual(await prompt, { text: "final", tools: [] });
    assert.equal(clients[0].promptCalls.length, 1);
  });

  test("serializes prompts and can cancel queued prompts", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { rpc, clients } = createRpc({
      onClient: (client) => {
        client.onPrompt = async (message) => {
          if (message === "first") await firstGate;
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: message } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "agent_end", messages: [{ stopReason: "end" }] } as unknown as AgentClientEvent);
        };
      },
    });

    rpc.start();
    const first = rpc.prompt("first");
    const second = rpc.prompt("second");
    const third = rpc.prompt("third");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rpc.queuedCount, 2);
    assert.equal(rpc.cancelQueued(), 2);
    await assert.rejects(second, /aborted/);
    await assert.rejects(third, /aborted/);

    releaseFirst();
    assert.deepEqual(await first, { text: "first", tools: [] });
    assert.deepEqual(clients[0].promptCalls.map((call) => call.message), ["first"]);
  });

  test("surfaces agent errors with stderr context", async () => {
    const { rpc } = createRpc({
      onClient: (client) => {
        client.stderr = "stderr detail";
        client.onPrompt = async () => {
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "error", error: { message: "stream broke" } } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "agent_end", messages: [{ stopReason: "error", content: [{ text: "final failure" }] }] } as unknown as AgentClientEvent);
        };
      },
    });

    rpc.start();
    await assert.rejects(() => rpc.prompt("fail"), /final failure\nstderr detail/);
    assert.equal(rpc.streaming, false);
  });

  test("delegates model, state, stats, abort, and kill operations to the client", async () => {
    const { rpc, clients } = createRpc();

    rpc.start();
    assert.deepEqual(await rpc.getAvailableModels(), [{ id: "m1", name: "Model 1", provider: "p1", reasoning: true }]);
    assert.deepEqual(await rpc.getAvailableThinkingLevels(), ["off", "medium", "high", "max"]);
    assert.deepEqual(await rpc.getState(), { model: { provider: "p1", id: "m1" }, thinkingLevel: "medium" });
    assert.deepEqual(await rpc.getSessionStats(), { cost: 0.01 });

    await rpc.setModel("p2", "m2");
    await rpc.setThinkingLevel("high");
    rpc.abort();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(clients[0].setModelCalls, [["p2", "m2"]]);
    assert.deepEqual(clients[0].setThinkingLevelCalls, ["high"]);
    assert.equal(clients[0].abortCalls, 1);

    rpc.kill();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clients[0].abortCalls, 2);
    assert.equal(clients[0].stopCalls, 0);
    assert.equal(clients[0].process.killedSignals.length, 0);
  });

  test("rejects client calls before start", async () => {
    const { rpc } = createRpc();

    await assert.rejects(() => rpc.getState(), /pi process not started/);
    await assert.rejects(() => rpc.prompt("hello"), /pi process not started/);
    assert.equal(rpc.alive, false);
  });

  test("adds stderr context when client startup fails", async () => {
    const { rpc, clients } = createRpc({
      onClient: (client) => {
        client.startError = new Error("cannot spawn");
        client.stderr = "spawn stderr";
      },
    });
    let exitCode: number | null | undefined = undefined;
    rpc.on("exit", (code) => {
      exitCode = code;
    });

    rpc.start();

    await assert.rejects(() => rpc.getState(), /cannot spawn\nspawn stderr/);
    assert.equal(clients[0].startCalls, 1);
    assert.equal(exitCode, null);
    assert.equal(rpc.alive, false);
  });

  test("falls back to process kill when graceful client stop fails", async () => {
    const { rpc, clients } = createRpc({
      killGraceMs: 5,
      onClient: (client) => {
        client.stopError = new Error("stop failed");
      },
    });

    rpc.start();
    await waitForStarted(rpc);
    rpc.kill();

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(clients[0].abortCalls, 1);
    assert.equal(clients[0].stopCalls, 1);
    assert.deepEqual(clients[0].process.killedSignals, ["SIGTERM"]);
    assert.equal(rpc.alive, false);
  });

  test("marks the RPC dead when the underlying process exits", async () => {
    const { rpc, clients } = createRpc();
    let exitCode: number | null | undefined;

    rpc.on("exit", (code) => {
      exitCode = code;
    });
    rpc.start();
    await waitForStarted(rpc);
    clients[0].process.emit("exit", 7);

    assert.equal(exitCode, 7);
    assert.equal(rpc.alive, false);
    assert.equal(rpc.streaming, false);
  });

  test("continues queued prompts after the first prompt rejects", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { rpc, clients } = createRpc({
      onClient: (client) => {
        client.onPrompt = async (message) => {
          if (message === "first") {
            await firstGate;
            throw new Error("first failed");
          }
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: message } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "agent_end", messages: [{ stopReason: "end" }] } as unknown as AgentClientEvent);
        };
      },
    });

    rpc.start();
    const first = rpc.prompt("first");
    const second = rpc.prompt("second");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rpc.queuedCount, 1);

    releaseFirst();
    await assert.rejects(first, /first failed/);
    assert.deepEqual(await second, { text: "second", tools: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(clients[0].promptCalls.map((call) => call.message), ["first", "second"]);
    assert.equal(rpc.running, false);
  });

  test("ignores streaming hook failures and still resolves", async () => {
    const { rpc } = createRpc({
      onClient: (client) => {
        client.onPrompt = async () => {
          client.emitEvent({ type: "tool_execution_start", toolName: "shell" } as unknown as AgentClientEvent);
          client.emitEvent({ type: "tool_execution_end", toolName: "shell", isError: true } as unknown as AgentClientEvent);
          client.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } } as unknown as AgentClientEvent);
          client.emitEvent({ type: "agent_end", messages: [{ stopReason: "end" }] } as unknown as AgentClientEvent);
        };
      },
    });

    rpc.start();
    const result = await rpc.prompt("hook fail", undefined, {
      onStart: () => { throw new Error("start hook"); },
      onTextDelta: () => { throw new Error("delta hook"); },
      onToolStart: () => { throw new Error("tool start hook"); },
      onToolError: () => { throw new Error("tool error hook"); },
    });

    assert.deepEqual(result, { text: "ok", tools: ["🔧 shell", "  ❌ error"] });
    assert.equal(rpc.streaming, false);
  });

  test("rejects aborted agent_end responses", async () => {
    const { rpc } = createRpc({
      onClient: (client) => {
        client.onPrompt = async () => {
          client.emitEvent({ type: "agent_end", messages: [{ stopReason: "aborted" }] } as unknown as AgentClientEvent);
        };
      },
    });

    rpc.start();
    await assert.rejects(() => rpc.prompt("abort me"), /aborted/);
    assert.equal(rpc.streaming, false);
  });

  test("rejects a running prompt when the process exits before agent_end", async () => {
    const { rpc, clients } = createRpc({
      onClient: (client) => {
        client.stderr = "tail stderr";
        client.onPrompt = async () => {
          client.process.emit("exit", 9);
        };
      },
    });

    rpc.start();
    await assert.rejects(() => rpc.prompt("exit early"), /pi exited with code 9\ntail stderr/);
    assert.equal(clients[0].promptCalls.length, 1);
    assert.equal(rpc.alive, false);
    assert.equal(rpc.streaming, false);
  });

  test("start is idempotent while a client is already started", async () => {
    const { rpc, clients } = createRpc();

    rpc.start();
    rpc.start();
    await waitForStarted(rpc);

    assert.equal(clients.length, 1);
    assert.equal(clients[0].startCalls, 1);
  });
});
