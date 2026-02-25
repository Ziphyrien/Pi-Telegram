#!/usr/bin/env node
// src/main.ts — entry point, only wiring
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { PiPool } from "./pool.js";
import { createBot } from "./bot.js";
import { log } from "./log.js";
import type { AppConfig } from "./types.js";

const telegramRoot = resolve(homedir(), ".pi", "telegram");
const settingsPath = resolve(telegramRoot, "settings.json");
const sessionsRoot = resolve(telegramRoot, "sessions");

mkdirSync(sessionsRoot, { recursive: true });

if (!existsSync(settingsPath)) {
  const template: AppConfig = {
    bots: [
      {
        token: "<YOUR_TELEGRAM_BOT_TOKEN>",
        name: "Pi-Telegram",
        allowedUsers: [],
        cwd: "",
        piArgs: [],
      },
    ],
    idleTimeoutMs: 600000,
    maxResponseLength: 4000,
  };

  writeFileSync(settingsPath, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
  log.warn(`settings.json 不存在，已自动生成模板: ${settingsPath}`);
  log.warn("请先填写 bot token，再重新启动。\n");
  process.exit(1);
}

const config: AppConfig = JSON.parse(readFileSync(settingsPath, "utf-8"));

// Wait for theme to load (top-level await in log.ts)

const bots: Array<{ stop: () => Promise<void> }> = [];
const pools: PiPool[] = [];
let shuttingDown = false;

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getTelegramErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as Record<string, unknown>).error_code;
  return typeof code === "number" ? code : undefined;
}

function describeRunnerError(err: unknown): string {
  const details: string[] = [formatErr(err)];

  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.error_code === "number") {
      details.push(`error_code=${rec.error_code}`);
    }
    if (typeof rec.description === "string" && rec.description.trim()) {
      details.push(`description=${rec.description}`);
    }
    const params = rec.parameters;
    if (params && typeof params === "object") {
      const retryAfter = (params as Record<string, unknown>).retry_after;
      if (typeof retryAfter === "number") {
        details.push(`retry_after=${retryAfter}s`);
      }
    }
  }

  return details.join(" | ");
}

function startRunnerWithAutoRestart(
  bot: ReturnType<typeof createBot>,
  botName: string,
): { stop: () => Promise<void> } {
  let runner: RunnerHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRestart = (reason: string, delayMs = 5000) => {
    if (shuttingDown) return;
    if (retryTimer) return;
    const delaySec = Math.max(1, Math.round(delayMs / 1000));
    log.warn(`"${botName}" 轮询已停止（${reason}），${delaySec} 秒后重试`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      log.warn(`"${botName}" 正在重启 Telegram 轮询...`);
      start();
    }, delayMs);
  };

  const watch = (current: RunnerHandle) => {
    const task = current.task();
    if (!task) return;

    task
      .then(() => {
        if (shuttingDown) return;
        if (runner !== current) return;
        scheduleRestart("runner task ended");
      })
      .catch((err) => {
        if (shuttingDown) return;
        if (runner !== current) return;

        const code = getTelegramErrorCode(err);
        log.error("boot", `"${botName}" 轮询异常：${describeRunnerError(err)}`);

        // runner 内部会对 getUpdates 做重试，这里只处理“已退出/不可恢复”情况。
        if (code === 401) {
          log.warn(`"${botName}" token 可能无效/已失效，请检查 settings.json（本次不自动重启）`);
          return;
        }

        if (code === 409) {
          log.warn(`"${botName}" 可能存在重复实例（同 token 多进程轮询）`);
          scheduleRestart("runner crashed code=409", 15000);
          return;
        }

        scheduleRestart(code ? `runner crashed code=${code}` : "runner crashed");
      });
  };

  const start = () => {
    if (shuttingDown) return;
    try {
      runner = run(bot, {
        runner: {
          maxRetryTime: 7 * 24 * 60 * 60 * 1000,
        },
      });
      watch(runner);
    } catch (err) {
      log.error("boot", `"${botName}" 启动轮询失败：${describeRunnerError(err)}`);
      scheduleRestart("start failed");
    }
  };

  start();

  return {
    stop: async () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (runner?.isRunning()) {
        await runner.stop();
      }
    },
  };
}

for (let i = 0; i < config.bots.length; i++) {
  const botCfg = config.bots[i];
  const cwd = botCfg.cwd || process.cwd();
  // Session storage is fixed to ~/.pi/telegram/sessions/<bot-name>/...
  const sessionBaseDir = resolve(sessionsRoot, botCfg.name || `bot${i}`);

  const pool = new PiPool({
    cwd,
    piArgs: botCfg.piArgs || [],
    sessionBaseDir,
    idleTimeoutMs: config.idleTimeoutMs || 600_000,
  });
  pools.push(pool);

  const bot = createBot({
    botIndex: i,
    config: botCfg,
    pool,
    maxResponseLength: config.maxResponseLength || 4000,
  });

  const handle = startRunnerWithAutoRestart(bot, botCfg.name || `bot${i}`);
  bots.push(handle);
  log.boot(`"${botCfg.name}" started`);
}

// Graceful shutdown
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log.shutdown("stopping...");
  for (const bot of bots) await bot.stop();
  for (const pool of pools) await pool.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log.boot(`${bots.length} bot(s) running. Ctrl+C to stop.`);
