// src/pi/pool.ts — pi RPC subprocess pool, one per chat
import { resolve } from "node:path";
import { PiRpc, type PiRpcOptions } from "./rpc.js";
import { log } from "../shared/log.js";

export interface PoolOptions {
  cwd: string;
  piArgs: string[];
  appendSystemPrompt?: string;
  sessionBaseDir: string;
  idleTimeoutMs: number;
  shutdownTimeoutMs?: number;
  rpcFactory?: (opts: PiRpcOptions) => PiRpc;
}

export class PiPool {
  private instances = new Map<string, PiRpc>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: PoolOptions) {
    this.timer = setInterval(() => this.reap(), 60_000);
  }

  get(chatKey: string): PiRpc {
    const existing = this.instances.get(chatKey);
    if (existing?.alive) return existing;
    return this.spawn(chatKey, true);
  }

  /** Spawn a fresh pi instance after stopping the current one. */
  async getFresh(chatKey: string): Promise<PiRpc> {
    const existing = this.instances.get(chatKey);
    if (existing?.alive) {
      const waitForExit = new Promise<void>((resolve) => existing.once("exit", () => resolve()));
      existing.kill();
      await Promise.race([
        waitForExit,
        new Promise<void>((resolve) => setTimeout(resolve, this.getStopTimeoutMs())),
      ]);
      existing.removeAllListeners();
    }
    return this.spawn(chatKey, false);
  }

  private getStopTimeoutMs(): number {
    return Math.max(0, this.opts.shutdownTimeoutMs ?? 2_500);
  }

  private buildPiArgs(): string[] {
    const args = [...this.opts.piArgs];
    const append = (this.opts.appendSystemPrompt || "").trim();
    if (!append) return args;
    if (args.includes("--append-system-prompt")) return args;
    return [...args, "--append-system-prompt", append];
  }

  private spawn(chatKey: string, continueSession: boolean): PiRpc {
    // Remove old dead instance listeners
    this.instances.get(chatKey)?.removeAllListeners();

    const createRpc = this.opts.rpcFactory ?? ((rpcOpts: PiRpcOptions) => new PiRpc(rpcOpts));
    const inst = createRpc({
      cwd: this.opts.cwd,
      piArgs: this.buildPiArgs(),
      sessionDir: resolve(this.opts.sessionBaseDir, chatKey),
      continueSession,
    });

    inst.once("exit", (code) => {
      if (this.instances.get(chatKey) !== inst) return;
      this.instances.delete(chatKey);
      log.pool(`pi exited for ${chatKey} (code=${code})`);
    });

    inst.start();
    this.instances.set(chatKey, inst);
    log.pool(`spawned pi for ${chatKey} (continue=${continueSession})`);
    return inst;
  }

  has(chatKey: string): PiRpc | undefined {
    return this.instances.get(chatKey);
  }

  get size(): number {
    return this.instances.size;
  }

  private reap(): void {
    const now = Date.now();
    for (const [key, inst] of this.instances) {
      if (inst.alive && !inst.streaming && now - inst.lastActivity > this.opts.idleTimeoutMs) {
        log.pool(`reaping idle ${key}`);
        inst.kill();
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    const shutdownTimeoutMs = this.getStopTimeoutMs();
    const waits: Promise<unknown>[] = [];
    for (const inst of this.instances.values()) {
      if (inst.alive) {
        inst.removeAllListeners();
        waits.push(new Promise<void>((resolve) => {
          let done = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const finish = () => {
            if (done) return;
            done = true;
            if (timeout) clearTimeout(timeout);
            inst.removeListener("exit", finish);
            resolve();
          };
          timeout = setTimeout(finish, shutdownTimeoutMs);
          timeout.unref?.();
          inst.once("exit", finish);
        }));
        inst.kill();
      }
    }
    await Promise.allSettled(waits);
    this.instances.clear();
  }
}
