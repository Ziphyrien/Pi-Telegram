// src/pi-rpc.ts — single pi RPC subprocess wrapper
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { PiImage, PiModelInfo, PiRpcEvent, PiSessionStats, PromptResult } from "./types.js";

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
  private proc: ChildProcess | null = null;
  private _alive = false;
  private _streaming = false;
  private _lastActivity = Date.now();
  private _queue: Array<{ run: () => void; reject: (err: Error) => void }> = [];
  private _busy = false;
  private _stderrTail: string[] = [];
  private _exitNotified = false;

  constructor(
    public readonly chatKey: string,
    private readonly opts: PiRpcOptions,
  ) {
    super();
  }

  get alive() { return this._alive; }
  get streaming() { return this._streaming; }
  get running() { return this._busy; }
  get queuedCount() { return this._queue.length; }
  get busy() { return this._busy || this._queue.length > 0; }
  get lastActivity() { return this._lastActivity; }

  /** Cancel queued prompts and abort current operation */
  abortAll(): void {
    while (this._queue.length) {
      const queued = this._queue.shift();
      queued?.reject(new Error("aborted"));
    }
    this.abort();
  }

  private appendStderr(chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!lines.length) return;

    this._stderrTail.push(...lines);
    if (this._stderrTail.length > 8) {
      this._stderrTail.splice(0, this._stderrTail.length - 8);
    }
  }

  private withStderrContext(base: string): Error {
    if (!this._stderrTail.length) return new Error(base);
    return new Error(`${base}\n${this._stderrTail.join("\n")}`);
  }

  private notifyExit(code: number | null): void {
    if (this._exitNotified) return;
    this._exitNotified = true;
    this._alive = false;
    this._streaming = false;
    this.emit("exit", code);
  }

  private toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }

  private extractRpcError(event: PiRpcEvent, fallback = "RPC error"): string {
    if (event.error) return event.error;
    const data = event.data;
    if (!data || typeof data !== "object") return fallback;

    const direct = (data as Record<string, unknown>).error;
    if (typeof direct === "string") return direct;

    if (direct && typeof direct === "object") {
      const msg = (direct as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim()) return msg;
      const desc = (direct as Record<string, unknown>).description;
      if (typeof desc === "string" && desc.trim()) return desc;
    }

    const msg = (data as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim()) return msg;

    return fallback;
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
    if (!parts.length) return undefined;
    return parts.join("\n").trim();
  }

  private extractAgentEndError(msgs: unknown[], last: any, streamHint = ""): string | undefined {
    const fromLastErrorObj =
      last?.error && typeof last.error === "object"
        ? (last.error as Record<string, unknown>)
        : undefined;

    const direct =
      (typeof last?.errorMessage === "string" && last.errorMessage)
      || (typeof fromLastErrorObj?.message === "string" && fromLastErrorObj.message)
      || (typeof fromLastErrorObj?.description === "string" && fromLastErrorObj.description)
      || (typeof last?.error === "string" && last.error)
      || (typeof last?.message === "string" && last.message)
      || this.extractTextFromContent(last?.content)
      || streamHint;

    if (direct && String(direct).trim()) return String(direct).trim();

    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const msg = msgs[i] as any;
      if (!msg || typeof msg !== "object") continue;

      if (typeof msg.errorMessage === "string" && msg.errorMessage.trim()) {
        return msg.errorMessage.trim();
      }

      if (msg.isError && typeof msg.error === "string" && msg.error.trim()) {
        return msg.error.trim();
      }

      if (msg.isError) {
        const txt = this.extractTextFromContent(msg.content);
        if (txt) return txt;
      }

      if (typeof msg.message === "string" && msg.message.trim()) {
        return msg.message.trim();
      }
    }

    return undefined;
  }

  start(): void {
    mkdirSync(this.opts.sessionDir, { recursive: true });

    const args = [
      "--mode", "rpc",
      "--session-dir", this.opts.sessionDir,
      ...(this.opts.continueSession ? ["-c"] : []),
      ...this.opts.piArgs,
    ];

    const isWin = process.platform === "win32";
    const cmd = isWin ? "cmd.exe" : "pi";
    const cmdArgs = isWin ? ["/d", "/s", "/c", "pi", ...args] : args;

    this.proc = spawn(cmd, cmdArgs, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this._alive = true;
    this._stderrTail = [];
    this._exitNotified = false;

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      try {
        const event: PiRpcEvent = JSON.parse(line);
        this._lastActivity = Date.now();
        this.emit("event", event);
      } catch { /* ignore non-JSON lines */ }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      this.appendStderr(raw);
      const msg = raw.trim();
      if (msg) this.emit("stderr", msg);
    });

    this.proc.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendStderr(`spawn error: ${msg}`);
      this.notifyExit(null);
    });

    this.proc.on("exit", (code) => {
      this.notifyExit(code);
    });
  }

  private send(cmd: Record<string, unknown>): void {
    if (!this._alive || !this.proc?.stdin) {
      throw this.withStderrContext("pi process not alive");
    }
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    this._lastActivity = Date.now();
  }

  prompt(message: string, images?: PiImage[], hooks?: PromptHooks): Promise<PromptResult> {
    return new Promise<PromptResult>((outerResolve, outerReject) => {
      const task = () => {
        this._busy = true;
        try { hooks?.onStart?.(); } catch { /* ignore hook error */ }
        this._doPrompt(message, images, hooks)
          .then((result) => { outerResolve(result); this._next(); })
          .catch((err) => { outerReject(err); this._next(); });
      };

      if (this._busy) {
        this._queue.push({ run: task, reject: outerReject });
      } else {
        task();
      }
    });
  }

  private _next(): void {
    this._busy = false;
    const next = this._queue.shift();
    if (next) next.run();
  }

  private _doPrompt(message: string, images?: PiImage[], hooks?: PromptHooks): Promise<PromptResult> {
    return new Promise((resolve, reject) => {
      let text = "";
      const toolInfo: string[] = [];
      let streamErrorHint = "";
      let done = false;

      const cleanup = () => {
        this.removeListener("event", onEvent);
        this.removeListener("exit", onExit);
      };

      const finishResolve = (result: PromptResult) => {
        if (done) return;
        done = true;
        this._streaming = false;
        cleanup();
        resolve(result);
      };

      const finishReject = (err: unknown) => {
        if (done) return;
        done = true;
        this._streaming = false;
        cleanup();
        reject(this.toError(err));
      };

      const onEvent = (event: PiRpcEvent) => {
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
          toolInfo.push(`🔧 ${event.toolName}`);
          try { hooks?.onToolStart?.(event.toolName); } catch { /* ignore hook error */ }
          return;
        }

        if (event.type === "tool_execution_end" && event.isError) {
          toolInfo.push("  ❌ error");
          try { hooks?.onToolError?.(event.toolName); } catch { /* ignore hook error */ }
          return;
        }

        if (event.type === "response" && event.success === false) {
          finishReject(this.withStderrContext(this.extractRpcError(event)));
          return;
        }

        if (event.type !== "agent_end") return;

        const msgs = (event.messages as any[]) ?? [];
        const last = msgs[msgs.length - 1] as any;
        const stopReason = String(last?.stopReason || "").toLowerCase();

        if (stopReason === "aborted") {
          finishReject(new Error("aborted"));
          return;
        }

        if (stopReason === "error" || stopReason === "failed" || last?.isError) {
          const errMsg = this.extractAgentEndError(msgs, last, streamErrorHint)
            || (stopReason ? `Agent ended with stopReason=${stopReason}` : "Agent ended with error");
          finishReject(this.withStderrContext(errMsg));
          return;
        }

        finishResolve({ text, tools: toolInfo });
      };

      const onExit = (code: number | null) => {
        finishReject(this.withStderrContext(`pi exited with code ${code}`));
      };

      this.on("event", onEvent);
      this.once("exit", onExit);

      const cmd: Record<string, unknown> = { type: "prompt", message };
      if (images?.length) cmd.images = images;
      if (this._streaming) cmd.streamingBehavior = "followUp";
      this._streaming = true;

      try {
        this.send(cmd);
      } catch (err) {
        finishReject(err);
      }
    });
  }

  newSession(): void {
    this.send({ type: "new_session" });
  }

  /** Generic RPC command that waits for a response */
  rpc(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let done = false;

      const cleanup = () => {
        this.removeListener("event", onEvent);
        this.removeListener("exit", onExit);
      };

      const finishResolve = (data: Record<string, unknown>) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(data);
      };

      const finishReject = (err: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        reject(this.toError(err));
      };

      const onEvent = (event: PiRpcEvent) => {
        if (event.type !== "response" || event.command !== cmd.type) return;
        if (event.success) {
          finishResolve(event.data ?? {});
        } else {
          finishReject(this.withStderrContext(this.extractRpcError(event)));
        }
      };

      const onExit = () => {
        finishReject(this.withStderrContext("pi exited"));
      };

      this.on("event", onEvent);
      this.once("exit", onExit);
      try {
        this.send(cmd);
      } catch (err) {
        finishReject(err);
      }
    });
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    const res = await this.rpc({ type: "get_available_models" });
    return (res as any).models ?? [];
  }

  async getState(): Promise<Record<string, unknown>> {
    return this.rpc({ type: "get_state" });
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const res = await this.rpc({ type: "get_session_stats" });
    return res as PiSessionStats;
  }

  async rpcSetModel(provider: string, modelId: string): Promise<void> {
    await this.rpc({ type: "set_model", provider, modelId });
  }

  async rpcSetThinkingLevel(level: string): Promise<void> {
    await this.rpc({ type: "set_thinking_level", level });
  }

  setModel(provider: string, modelId: string): void {
    this.send({ type: "set_model", provider, modelId });
  }

  setThinkingLevel(level: string): void {
    this.send({ type: "set_thinking_level", level });
  }

  abort(): void {
    if (this._alive) this.send({ type: "abort" });
  }

  kill(): void {
    if (!this.proc || !this._alive) return;
    this.abort();
    setTimeout(() => {
      if (this._alive) this.proc?.kill("SIGTERM");
    }, 2000);
  }
}
