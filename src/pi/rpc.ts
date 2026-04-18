// src/pi/rpc.ts — single pi RPC subprocess wrapper
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@mariozechner/pi-coding-agent";
import type { PiImage, PiModelInfo, PiSessionStats } from "./types.js";

const piEntryJs = fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
const piCliPath = resolve(dirname(piEntryJs), "cli.js");

type PromptResult = { text: string; tools: string[] };
type RpcClientEvent = Parameters<Parameters<RpcClient["onEvent"]>[0]>[0];

export interface PiRpcOptions {
  cwd: string;
  piArgs: string[];
  sessionDir: string;
  continueSession: boolean;
}

export interface PromptHooks {
  onStart?: () => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onToolStart?: (toolName?: string) => void;
  onToolError?: (toolName?: string) => void;
}

export class PiRpc extends EventEmitter {
  private client: RpcClient | null = null;
  private startPromise: Promise<void> | null = null;
  alive = false;
  streaming = false;
  lastActivity = Date.now();
  private _queue: Array<{ run: () => void; reject: (err: Error) => void }> = [];
  running = false;
  private _stderrTail: string[] = [];
  private _exitNotified = false;

  constructor(private readonly opts: PiRpcOptions) {
    super();
  }

  get queuedCount() { return this._queue.length; }

  /** Cancel queued prompts only. Returns number of cancelled queued requests. */
  cancelQueued(): number {
    const queued = this._queue.splice(0);
    queued.forEach(({ reject }) => reject(new Error("aborted")));
    return queued.length;
  }

  private stderrLines(extra = ""): string[] {
    return Array.from(new Set([
      ...this._stderrTail,
      ...[extra, this.client?.getStderr() ?? ""].flatMap((chunk) =>
        chunk.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      ),
    ])).slice(-8);
  }

  private withStderrContext(base: string): Error {
    const lines = this.stderrLines();
    if (!lines.length) return new Error(base);
    return new Error(`${base}\n${lines.join("\n")}`);
  }

  private notifyExit(code: number | null): void {
    if (this._exitNotified) return;
    this._exitNotified = true;
    this._stderrTail = this.stderrLines();
    this.alive = false;
    this.streaming = false;
    this.startPromise = null;
    this.client = null;
    this.emit("exit", code);
  }

  private toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }

  private extractTextFromContent(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts = content
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        const rec = b as Record<string, unknown>;
        if (typeof rec.text === "string") return rec.text.trim();
        if (typeof rec.content === "string") return rec.content.trim();
        return "";
      })
      .filter(Boolean);
    return parts.length ? parts.join("\n").trim() : undefined;
  }

  private extractAgentEndError(msgs: unknown[], last: any, streamHint = ""): string | undefined {
    const errObj = last?.error && typeof last.error === "object"
      ? (last.error as Record<string, unknown>)
      : undefined;
    const direct = [
      typeof last?.errorMessage === "string" ? last.errorMessage : "",
      typeof errObj?.message === "string" ? errObj.message : "",
      typeof errObj?.description === "string" ? errObj.description : "",
      typeof last?.error === "string" ? last.error : "",
      typeof last?.message === "string" ? last.message : "",
      this.extractTextFromContent(last?.content) ?? "",
      streamHint,
    ].find((value) => value.trim());
    if (direct) return direct.trim();

    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const msg = msgs[i] as any;
      if (!msg || typeof msg !== "object") continue;
      const fallback = [
        typeof msg.errorMessage === "string" ? msg.errorMessage : "",
        msg.isError && typeof msg.error === "string" ? msg.error : "",
        msg.isError ? this.extractTextFromContent(msg.content) ?? "" : "",
        typeof msg.message === "string" ? msg.message : "",
      ].find((value) => value.trim());
      if (fallback) return fallback.trim();
    }
  }

  private async startClient(): Promise<void> {
    mkdirSync(this.opts.sessionDir, { recursive: true });

    const client = new RpcClient({
      cwd: this.opts.cwd,
      cliPath: piCliPath,
      args: [
        "--session-dir", this.opts.sessionDir,
        ...(this.opts.continueSession ? ["-c"] : []),
        ...this.opts.piArgs,
      ],
    });

    this.client = client;
    client.onEvent(() => { this.lastActivity = Date.now(); });

    try {
      await client.start();
    } catch (err) {
      this._stderrTail = this.stderrLines(this.toError(err).message);
      this.notifyExit(null);
      throw err;
    }

    const proc = (client as any).process as ChildProcess | null | undefined;
    proc?.on("error", (err) => { this._stderrTail = this.stderrLines(this.toError(err).message); this.notifyExit(null); });
    proc?.on("exit", (code) => { this.notifyExit(code); });
  }

  private async ensureStarted(): Promise<RpcClient> {
    if (!this.startPromise) throw new Error("pi process not started");
    try {
      await this.startPromise;
    } catch (err) {
      throw this.withStderrContext(this.toError(err).message);
    }
    if (!this.alive || !this.client) {
      throw this.withStderrContext("pi process not alive");
    }
    return this.client;
  }

  private withClient<T>(run: (client: RpcClient) => Promise<T>): Promise<T> {
    return this.ensureStarted().then(run);
  }

  start(): void {
    if (this.startPromise) return;
    this.alive = true;
    this._stderrTail = [];
    this._exitNotified = false;
    this.startPromise = this.startClient();
  }

  prompt(message: string, images?: PiImage[], hooks?: PromptHooks): Promise<PromptResult> {
    return new Promise<PromptResult>((outerResolve, outerReject) => {
      const advanceQueue = () => {
        this.running = false;
        this._queue.shift()?.run();
      };
      const task = () => {
        this.running = true;
        try { hooks?.onStart?.(); } catch { /* ignore hook error */ }
        this._doPrompt(message, images, hooks)
          .then(outerResolve, outerReject)
          .finally(advanceQueue);
      };

      if (this.running) {
        this._queue.push({ run: task, reject: outerReject });
        return;
      }
      task();
    });
  }

  private async _doPrompt(message: string, images?: PiImage[], hooks?: PromptHooks): Promise<PromptResult> {
    const client = await this.ensureStarted();
    let text = "";
    const tools: string[] = [];
    let streamErrorHint = "";
    let endMessages: unknown[] = [];

    let detachExit = () => {};
    let resolveAgentEnd = () => {};
    const exitPromise = new Promise<never>((_, reject) => {
      const onExit = (code: number | null) => reject(this.withStderrContext(`pi exited with code ${code}`));
      this.once("exit", onExit);
      detachExit = () => this.removeListener("exit", onExit);
    });
    const agentEndPromise = new Promise<void>((resolve) => {
      resolveAgentEnd = resolve;
    });

    const detachEvent = client.onEvent((event: RpcClientEvent) => {
      if (event.type === "message_update") {
        const streamEvent = event.assistantMessageEvent as any;
        if (streamEvent?.type === "text_delta") {
          const delta = streamEvent.delta ?? "";
          text += delta;
          try { hooks?.onTextDelta?.(delta, text); } catch { /* ignore hook error */ }
        } else if (streamEvent?.type === "error") {
          const errObj = streamEvent?.error && typeof streamEvent.error === "object"
            ? (streamEvent.error as Record<string, unknown>)
            : undefined;
          streamErrorHint =
            (typeof errObj?.message === "string" && errObj.message)
            || (typeof errObj?.description === "string" && errObj.description)
            || (typeof streamEvent?.message === "string" && streamEvent.message)
            || (typeof streamEvent?.reason === "string" && streamEvent.reason)
            || streamErrorHint;
        }
        return;
      }

      if (event.type === "tool_execution_start") {
        tools.push(`🔧 ${event.toolName}`);
        try { hooks?.onToolStart?.(event.toolName); } catch { /* ignore hook error */ }
        return;
      }

      if (event.type === "tool_execution_end" && event.isError) {
        tools.push("  ❌ error");
        try { hooks?.onToolError?.(event.toolName); } catch { /* ignore hook error */ }
        return;
      }

      if (event.type === "agent_end") {
        endMessages = (event as any).messages ?? [];
        resolveAgentEnd();
      }
    });

    this.streaming = true;
    try {
      await client.prompt(message, images as any);
      await Promise.race([agentEndPromise, exitPromise]);
    } catch (err) {
      throw this.withStderrContext(this.toError(err).message);
    } finally {
      this.streaming = false;
      detachEvent();
      detachExit();
    }

    const last = endMessages.at(-1) as any;
    const stopReason = String(last?.stopReason || "").toLowerCase();

    if (stopReason === "aborted") {
      throw new Error("aborted");
    }

    if (stopReason === "error" || stopReason === "failed" || last?.isError) {
      const errMsg = this.extractAgentEndError(endMessages, last, streamErrorHint)
        || (stopReason ? `Agent ended with stopReason=${stopReason}` : "Agent ended with error");
      throw this.withStderrContext(errMsg);
    }

    return { text, tools };
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    return this.withClient((client) => client.getAvailableModels() as unknown as Promise<PiModelInfo[]>);
  }

  async getState(): Promise<Record<string, unknown>> {
    return this.withClient((client) => client.getState() as unknown as Promise<Record<string, unknown>>);
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return this.withClient((client) => client.getSessionStats() as unknown as Promise<PiSessionStats>);
  }

  rpcSetModel(provider: string, modelId: string): Promise<void> {
    return this.withClient(async (client) => { await client.setModel(provider, modelId); });
  }

  rpcSetThinkingLevel(level: string): Promise<void> {
    return this.withClient((client) => client.setThinkingLevel(level as any));
  }

  abort(): void {
    if (!this.alive) return;
    void this.withClient((client) => client.abort()).catch(() => {});
  }

  kill(): void {
    if (!this.alive) return;
    const client = this.client;
    const proc = (client as any)?.process as ChildProcess | null | undefined;
    this.abort();
    setTimeout(() => {
      if (!this.alive) return;
      if (client) {
        void client.stop().catch(() => {
          if (this.alive) proc?.kill("SIGTERM");
        });
        return;
      }
      proc?.kill("SIGTERM");
    }, 2000);
  }
}
