import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { log } from "./platform/logger.js";
import type { PiImage, PiModelInfo, PiSessionStats } from "./types.js";

const piCliPath = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");

type PromptResult = { text: string; tools: string[] };
export type AgentClientEvent = Parameters<Parameters<RpcClient["onEvent"]>[0]>[0];

export interface AgentClientOptions {
  cwd: string;
  cliPath: string;
  args: string[];
}

export interface AgentClient {
  process?: ChildProcess | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string, images?: unknown): Promise<void>;
  onEvent(handler: (event: AgentClientEvent) => void): () => void;
  getStderr(): string;
  getAvailableModels(): Promise<PiModelInfo[]>;
  getAvailableThinkingLevels(): Promise<string[]>;
  getState(): Promise<Record<string, unknown>>;
  getSessionStats(): Promise<PiSessionStats>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: unknown): Promise<void>;
  abort(): Promise<void>;
}

export type AgentClientFactory = (options: AgentClientOptions) => AgentClient;

export interface AgentSessionOptions {
  cwd: string;
  piArgs: string[];
  sessionDir: string;
  continueSession: boolean;
  clientFactory?: AgentClientFactory;
  killGraceMs?: number;
}

export interface PromptHooks {
  onStart?: () => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onToolStart?: (toolName?: string) => void;
  onToolError?: (toolName?: string) => void;
}

export interface AgentPoolOptions {
  cwd: string;
  piArgs: string[];
  appendSystemPrompt?: string;
  sessionBaseDir: string;
  idleTimeoutMs: number;
  shutdownTimeoutMs?: number;
  sessionFactory?: (options: AgentSessionOptions) => AgentSession;
}

export class AgentSession extends EventEmitter {
  private client: AgentClient | null = null;
  private startPromise: Promise<void> | null = null;
  alive = false;
  streaming = false;
  lastActivity = Date.now();
  private queue: Array<{ run: () => void; reject: (err: Error) => void }> = [];
  running = false;
  private stderrTail: string[] = [];
  private exitNotified = false;

  constructor(private readonly opts: AgentSessionOptions) {
    super();
  }

  get queuedCount() { return this.queue.length; }

  /** Cancel queued prompts only. Returns number of cancelled queued requests. */
  cancelQueued(): number {
    const queued = this.queue.splice(0);
    queued.forEach(({ reject }) => reject(new Error("aborted")));
    return queued.length;
  }

  private stderrLines(extra = ""): string[] {
    return Array.from(new Set([
      ...this.stderrTail,
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
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.stderrTail = this.stderrLines();
    this.alive = false;
    this.streaming = false;
    this.startPromise = null;
    this.client = null;
    this.emit("exit", code);
  }

  private toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }

  private notifyHook<Args extends unknown[]>(hook: ((...args: Args) => void) | undefined, ...args: Args): void {
    try {
      hook?.(...args);
    } catch {
      // Hooks are observers; a failing observer must not fail the prompt.
    }
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

  private extractAssistantText(message: unknown): string | undefined {
    if (!message || typeof message !== "object") return undefined;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") return undefined;

    const content = record.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;

    return content.map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as Record<string, unknown>;
      return typeof item.text === "string" ? item.text : "";
    }).join("");
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

    const createClient = this.opts.clientFactory
      ?? ((clientOpts: AgentClientOptions) => new RpcClient(clientOpts) as unknown as AgentClient);
    const client = createClient({
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
      this.stderrTail = this.stderrLines(this.toError(err).message);
      this.notifyExit(null);
      throw err;
    }

    const proc = client.process;
    proc?.on("error", (err) => { this.stderrTail = this.stderrLines(this.toError(err).message); this.notifyExit(null); });
    proc?.on("exit", (code) => { this.notifyExit(code); });
  }

  private async ensureStarted(): Promise<AgentClient> {
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

  private withClient<T>(run: (client: AgentClient) => Promise<T>): Promise<T> {
    return this.ensureStarted().then(run);
  }

  start(): void {
    if (this.startPromise) return;
    this.alive = true;
    this.stderrTail = [];
    this.exitNotified = false;
    this.startPromise = this.startClient();
  }

  prompt(message: string, images?: PiImage[], hooks?: PromptHooks): Promise<PromptResult> {
    return new Promise<PromptResult>((outerResolve, outerReject) => {
      const advanceQueue = () => {
        this.running = false;
        this.queue.shift()?.run();
      };
      const task = () => {
        this.running = true;
        this.notifyHook(hooks?.onStart);
        this.runPrompt(message, images, hooks)
          .then(outerResolve, outerReject)
          .finally(advanceQueue);
      };

      if (this.running) {
        this.queue.push({ run: task, reject: outerReject });
        return;
      }
      task();
    });
  }

  private async runPrompt(message: string, images?: PiImage[], hooks?: PromptHooks): Promise<PromptResult> {
    const client = await this.ensureStarted();
    let text = "";
    const tools: string[] = [];
    let streamErrorHint = "";
    let endMessages: unknown[] = [];
    let assistantTextOffset: number | null = null;
    let resetForRetry = false;

    let detachExit = () => {};
    let resolveSettled!: () => void;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveSettled();
    };
    const exitPromise = new Promise<never>((_, reject) => {
      const onExit = (code: number | null) => reject(this.withStderrContext(`pi exited with code ${code}`));
      this.once("exit", onExit);
      detachExit = () => this.removeListener("exit", onExit);
    });
    const agentSettledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    const detachEvent = client.onEvent((event: AgentClientEvent) => {
      if (event.type === "agent_start") {
        if (resetForRetry) {
          text = "";
          tools.length = 0;
          streamErrorHint = "";
          endMessages = [];
          assistantTextOffset = null;
          resetForRetry = false;
          this.notifyHook(hooks?.onTextDelta, "", "");
        }
        return;
      }

      if (event.type === "message_start") {
        const startedMessage = (event as any).message;
        if (startedMessage?.role === "assistant") {
          assistantTextOffset = text.length;
        }
        return;
      }

      if (event.type === "message_update") {
        const streamEvent = event.assistantMessageEvent as any;
        if (streamEvent?.type === "text_delta") {
          const delta = typeof streamEvent.delta === "string" ? streamEvent.delta : "";
          text += delta;
          this.notifyHook(hooks?.onTextDelta, delta, text);
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

      if (event.type === "message_end") {
        const finalText = this.extractAssistantText((event as any).message);
        if (finalText !== undefined && assistantTextOffset !== null) {
          const correctedText = text.slice(0, assistantTextOffset) + finalText;
          if (correctedText !== text) {
            text = correctedText;
            this.notifyHook(hooks?.onTextDelta, "", text);
          }
          assistantTextOffset = null;
        }
        return;
      }

      if (event.type === "tool_execution_start") {
        tools.push(`🔧 ${event.toolName}`);
        this.notifyHook(hooks?.onToolStart, event.toolName);
        return;
      }

      if (event.type === "tool_execution_end" && event.isError) {
        tools.push("  ❌ error");
        this.notifyHook(hooks?.onToolError, event.toolName);
        return;
      }

      if (event.type === "agent_end") {
        const messages = (event as any).messages;
        if (Array.isArray(messages)) endMessages = messages;
        resetForRetry = (event as any).willRetry === true;
        return;
      }

      if (event.type === "agent_settled") {
        settle();
      }
    });

    this.streaming = true;
    try {
      await client.prompt(message, images as any);
      await Promise.race([agentSettledPromise, exitPromise]);
    } catch (err) {
      throw this.withStderrContext(this.toError(err).message);
    } finally {
      this.streaming = false;
      detachEvent();
      detachExit();
    }

    if (!text) {
      for (let i = endMessages.length - 1; i >= 0; i -= 1) {
        const fallbackText = this.extractAssistantText(endMessages[i]);
        if (fallbackText !== undefined) {
          text = fallbackText;
          break;
        }
      }
    }

    const last = endMessages.at(-1) as any;
    const lastAssistant = [...endMessages].reverse().find((item) => (item as any)?.role === "assistant") as any;
    const terminal = lastAssistant ?? last;
    const stopReason = String(terminal?.stopReason || last?.stopReason || "").toLowerCase();

    if (stopReason === "aborted") {
      throw new Error("aborted");
    }

    if (stopReason === "error" || stopReason === "failed" || terminal?.isError) {
      const errMsg = this.extractAgentEndError(endMessages, terminal, streamErrorHint)
        || (stopReason ? `Agent ended with stopReason=${stopReason}` : "Agent ended with error");
      throw this.withStderrContext(errMsg);
    }

    return { text, tools };
  }

  async getAvailableModels(): Promise<PiModelInfo[]> {
    return this.withClient((client) => client.getAvailableModels());
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return this.withClient(async (client) => {
      const levels = await client.getAvailableThinkingLevels();
      return Array.isArray(levels) ? levels.map((level) => String(level)).filter(Boolean) : [];
    });
  }

  async getState(): Promise<Record<string, unknown>> {
    return this.withClient((client) => client.getState());
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return this.withClient((client) => client.getSessionStats());
  }

  setModel(provider: string, modelId: string): Promise<void> {
    return this.withClient(async (client) => { await client.setModel(provider, modelId); });
  }

  setThinkingLevel(level: string): Promise<void> {
    return this.withClient((client) => client.setThinkingLevel(level));
  }

  abort(): void {
    if (!this.alive) return;
    void this.withClient((client) => client.abort()).catch(() => {});
  }

  kill(): void {
    if (!this.alive) return;
    const client = this.client;
    const proc = client?.process;
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
    }, this.opts.killGraceMs ?? 2000);
  }
}


export class AgentPool {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: AgentPoolOptions) {
    this.timer = setInterval(() => this.reap(), 60_000);
  }

  get(chatKey: string): AgentSession {
    const current = this.sessions.get(chatKey);
    if (current?.alive) return current;
    return this.spawn(chatKey, true);
  }

  async getFresh(chatKey: string): Promise<AgentSession> {
    const current = this.sessions.get(chatKey);
    if (current?.alive) {
      const exited = this.waitForExit(current, this.shutdownTimeoutMs());
      current.kill();
      await exited;
      current.removeAllListeners();
    }
    return this.spawn(chatKey, false);
  }

  has(chatKey: string): AgentSession | undefined {
    return this.sessions.get(chatKey);
  }

  get size(): number {
    return this.sessions.size;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    const waits: Promise<void>[] = [];

    for (const session of this.sessions.values()) {
      if (!session.alive) continue;
      session.removeAllListeners();
      waits.push(this.waitForExit(session, this.shutdownTimeoutMs(), true));
      session.kill();
    }

    await Promise.allSettled(waits);
    this.sessions.clear();
  }

  private shutdownTimeoutMs(): number {
    return Math.max(0, this.options.shutdownTimeoutMs ?? 2_500);
  }

  private buildSessionArgs(): string[] {
    const append = (this.options.appendSystemPrompt || "").trim();
    if (!append || this.options.piArgs.includes("--append-system-prompt")) {
      return [...this.options.piArgs];
    }
    return [...this.options.piArgs, "--append-system-prompt", append];
  }

  private spawn(chatKey: string, continueSession: boolean): AgentSession {
    this.sessions.get(chatKey)?.removeAllListeners();

    const createSession = this.options.sessionFactory ?? ((sessionOptions: AgentSessionOptions) => new AgentSession(sessionOptions));
    const session = createSession({
      cwd: this.options.cwd,
      piArgs: this.buildSessionArgs(),
      sessionDir: resolve(this.options.sessionBaseDir, chatKey),
      continueSession,
    });

    session.once("exit", (code) => {
      if (this.sessions.get(chatKey) !== session) return;
      this.sessions.delete(chatKey);
      log.pool(`pi exited for ${chatKey} (code=${code})`);
    });

    session.start();
    this.sessions.set(chatKey, session);
    log.pool(`spawned pi for ${chatKey} (continue=${continueSession})`);
    return session;
  }

  private waitForExit(session: AgentSession, timeoutMs: number, unrefTimeout = false): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        session.removeListener("exit", finish);
        resolve();
      };

      timeout = setTimeout(finish, timeoutMs);
      if (unrefTimeout) timeout.unref?.();
      session.once("exit", finish);
    });
  }

  private reap(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      const idle = now - session.lastActivity > this.options.idleTimeoutMs;
      if (session.alive && !session.streaming && idle) {
        log.pool(`reaping idle ${key}`);
        session.kill();
      }
    }
  }
}
