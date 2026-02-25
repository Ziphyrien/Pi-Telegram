// src/pool.ts — pi RPC subprocess pool, one per chat
import { resolve } from "node:path";
import { PiRpc } from "./pi-rpc.js";
import { log } from "./log.js";

export interface PoolOptions {
  cwd: string;
  piArgs: string[];
  sessionBaseDir: string;
  idleTimeoutMs: number;
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

  /** Spawn a fresh pi instance, no session restore */
  getFresh(chatKey: string): PiRpc {
    const existing = this.instances.get(chatKey);
    if (existing?.alive) {
      existing.kill();
    }
    return this.spawn(chatKey, false);
  }

  private spawn(chatKey: string, continueSession: boolean): PiRpc {
    // Remove old dead instance listeners
    const old = this.instances.get(chatKey);
    if (old) old.removeAllListeners();

    const inst = new PiRpc(chatKey, {
      cwd: this.opts.cwd,
      piArgs: this.opts.piArgs,
      sessionDir: resolve(this.opts.sessionBaseDir, chatKey),
      continueSession,
    });

    inst.on("stderr", (msg) => {
      if (this.instances.get(chatKey) === inst) {
        log.error("pi", `${chatKey}: ${msg}`);
      }
    });

    inst.on("exit", (code) => {
      // Only log if this instance is still the active one
      if (this.instances.get(chatKey) === inst) {
        log.pool(`pi exited for ${chatKey} (code=${code})`);
      }
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
    const waits: Promise<unknown>[] = [];
    for (const inst of this.instances.values()) {
      if (inst.alive) {
        inst.removeAllListeners();
        inst.kill();
        waits.push(new Promise((r) => inst.once("exit", r)));
      }
    }
    await Promise.allSettled(waits);
  }
}
