// src/app/runtime.ts — app assembly and startup orchestration
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { PiPool } from "../pi/pool.js";
import { createBot } from "../telegram/create-bot.js";
import { CronService } from "../cron/service.js";
import type { MemoryService } from "../memory/service.js";
import { hasUsableMemoryLlmConfig } from "../memory/config.js";
import { prepareSameRepoBridgeCache } from "../memory/bridge-distribution/cache.js";
import { fetchSameRepoBridgeFromGitHub } from "../memory/bridge-distribution/github.js";
import { generateProviderRegistrationExtension } from "../memory/provider-extension/generator.js";
import { log } from "../shared/log.js";
import { getRegisteredToolSystemPrompt } from "../telegram/tool-prompt.js";
import {
  checkLatestVersion,
  getNewChangelogText,
  getPackageDir,
  getPackageMeta,
  getUpdateInstruction,
  shouldCheckUpdatesOnStartup,
} from "../shared/version.js";
import { createSettingsWriter, ensureSettingsFileExists, normalizeCronConfig, normalizeMemoryConfig, normalizeStreamByChat, readAppConfig } from "./config.js";
import { cronRoot, defaultWorkspace, ensureAppDirectories, sessionsRoot, settingsPath, telegramRoot } from "./paths.js";

const bots: Array<{ stop: () => Promise<void> }> = [];
const pools: PiPool[] = [];
const cronServices: CronService[] = [];
let memoryService: MemoryService | null = null;
let memoryBridgeServer: { token: string; url: string; close: () => Promise<void> } | null = null;
let shuttingDown = false;
let booted = false;

function buildBotKey(token: string): string {
  return createHash("sha1").update(token).digest("hex").slice(0, 12);
}

function parseChatIdFromChatKey(chatKey: string): number | undefined {
  const match = chatKey.match(/_chat(-?\d+)$/);
  if (!match) return undefined;
  const chatId = Number(match[1]);
  return Number.isSafeInteger(chatId) ? chatId : undefined;
}

function buildWorkspaceId(workspaceCwd: string): string {
  const normalized = String(workspaceCwd || "").trim() || "workspace:default";
  return `repo.${createHash("sha1").update(normalized).digest("hex").slice(0, 10)}`;
}

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

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log.shutdown("stopping...");
  for (const bot of bots) await bot.stop();
  for (const cron of cronServices) await cron.stop();
  for (const pool of pools) await pool.shutdown();
  await memoryBridgeServer?.close().catch(() => {});
  memoryService?.shutdown();
  process.exit(0);
}

export async function runApp(): Promise<void> {
  if (booted) return;
  booted = true;

  ensureAppDirectories();

  const packageMeta = getPackageMeta();
  const { name: packageName, version: appVersion, repository: packageRepository } = packageMeta;

  if (ensureSettingsFileExists(appVersion)) {
    log.warn(`settings.json 不存在，已自动生成模板: ${settingsPath}`);
    log.warn("请先填写 bot token，再重新启动。\n");
    process.exit(1);
    return;
  }

  const config = readAppConfig();
  let needsSettingsRewrite = false;

  log.boot(`Pi-Telegram v${appVersion}`);

  if (!config.lastChangelogVersion) {
    config.lastChangelogVersion = appVersion;
    needsSettingsRewrite = true;
  } else if (config.lastChangelogVersion !== appVersion) {
    const changelogText = getNewChangelogText(config.lastChangelogVersion);
    if (changelogText) {
      log.warn(`检测到新版本变更（${config.lastChangelogVersion} -> ${appVersion}）：`);
      for (const line of changelogText.split(/\r?\n/)) {
        if (line.trim()) log.warn(line);
      }
    }

    config.lastChangelogVersion = appVersion;
    needsSettingsRewrite = true;
  }

  if (shouldCheckUpdatesOnStartup()) {
    void checkLatestVersion(packageName, appVersion).then((newVersion) => {
      if (!newVersion) return;
      log.warn(`发现新版本 ${newVersion} 可用。${getUpdateInstruction(packageName)}`);
      log.warn("Changelog: https://github.com/Ziphyrien/Pi-Telegram/blob/main/CHANGELOG.md");
    });
  }

  const normalizedCron = normalizeCronConfig(config.cron);
  config.cron = normalizedCron.value;
  if (normalizedCron.changed) {
    needsSettingsRewrite = true;
  }

  const normalizedMemory = normalizeMemoryConfig(config.memory);
  config.memory = normalizedMemory.value;
  if (normalizedMemory.changed) {
    needsSettingsRewrite = true;
  }

  const bridgeProtocolVersion = 1;
  const packageDir = getPackageDir();
  const extensionCacheRoot = resolve(telegramRoot, "extensions-cache");
  const desiredRefs = [process.env.PITG_REPO_REF || `v${appVersion}`, appVersion].filter(Boolean);
  let cachedBridge = packageRepository
    ? await fetchSameRepoBridgeFromGitHub({
      repo: packageRepository,
      refs: desiredRefs,
      cacheRoot: extensionCacheRoot,
      appVersion,
      expectedProtocolVersion: bridgeProtocolVersion,
    })
    : { ok: false, reason: "missing package repository metadata" };

  if (!cachedBridge.ok) {
    cachedBridge = prepareSameRepoBridgeCache({
      packageDir,
      cacheRoot: extensionCacheRoot,
      appVersion,
      expectedProtocolVersion: bridgeProtocolVersion,
      repoRef: appVersion,
    });
  }
  if (!cachedBridge.ok) {
    log.warn(`memory bridge manifest/cache 校验失败，运行时将回退为 direct memory：${cachedBridge.reason}`);
  }

  const providerExtensionEntryPath = normalizedMemory.value.enabled && hasUsableMemoryLlmConfig(normalizedMemory.value.llm)
    ? generateProviderRegistrationExtension(
      resolve(extensionCacheRoot, "memory-provider", `v${appVersion}`),
      normalizedMemory.value.llm,
    ).entryPath
    : undefined;

  if (normalizedMemory.value.enabled) {
    const { createMemoryService } = await import("../memory/service.js");
    const { startMemoryBridgeServer } = await import("../memory/bridge-server/http.js");
    memoryService = createMemoryService({
      enabled: normalizedMemory.value.enabled,
      storePath: normalizedMemory.value.storePath,
      maxContextChars: normalizedMemory.value.maxContextChars,
      maxRetrievedMemories: normalizedMemory.value.maxRetrievedMemories,
      maxRecentTurns: normalizedMemory.value.maxRecentTurns,
      trace: normalizedMemory.value.trace,
      providerExtensionEntryPath,
      llm: normalizedMemory.value.llm,
      embedding: normalizedMemory.value.embedding,
    });
    if (memoryService.enabled) {
      memoryBridgeServer = await startMemoryBridgeServer(memoryService, {
        appVersion,
        bridgeProtocolVersion,
      });
      log.boot(`memory enabled (${normalizedMemory.value.storePath})`);
      log.boot(`memory bridge api ${memoryBridgeServer.url}`);
      if (providerExtensionEntryPath) {
        log.boot(`memory provider extension ${providerExtensionEntryPath}`);
      }
      if (cachedBridge.ok && cachedBridge.entryPath) {
        log.boot(`memory bridge extension cache ${cachedBridge.entryPath}`);
      }
    }
  } else {
    memoryService = null;
    memoryBridgeServer = null;
  }

  const queueWriteSettings = createSettingsWriter(config);

  const toolSystemPrompt = getRegisteredToolSystemPrompt().trim();
  const toolSystemPromptFile = resolve(telegramRoot, "tool-system-prompt.txt");
  if (toolSystemPrompt) {
    writeFileSync(toolSystemPromptFile, `${toolSystemPrompt}\n`, "utf-8");
  }
  const toolSystemPromptArg = toolSystemPrompt ? toolSystemPromptFile : "";

  for (let i = 0; i < config.bots.length; i++) {
    const botCfg = config.bots[i];
    const hasStreamByChat = Object.prototype.hasOwnProperty.call(botCfg, "streamByChat");
    const normalizedStream = normalizeStreamByChat(botCfg.streamByChat);
    botCfg.streamByChat = normalizedStream.value;
    if (!hasStreamByChat || normalizedStream.changed) {
      needsSettingsRewrite = true;
    }

    const cwd = botCfg.cwd || defaultWorkspace;
    botCfg.cwd = cwd;
    const botName = botCfg.name || `bot${i}`;
    const sessionBaseDir = resolve(sessionsRoot, botName);

    const botKey = buildBotKey(botCfg.token);
    const bridgeExtensionPath = cachedBridge.ok ? cachedBridge.entryPath : undefined;
    const memoryPiArgs = memoryService?.enabled
      ? [
        ...(providerExtensionEntryPath ? ["-e", providerExtensionEntryPath] : []),
        ...(bridgeExtensionPath ? ["-e", bridgeExtensionPath] : []),
      ]
      : [];
    const memoryTransport = !memoryService?.enabled
      ? "disabled"
      : bridgeExtensionPath
        ? "bridge"
        : "direct";

    const pool = new PiPool({
      cwd,
      piArgs: memoryPiArgs,
      appendSystemPrompt: toolSystemPromptArg,
      sessionBaseDir,
      idleTimeoutMs: config.idleTimeoutMs || 600_000,
      getEnv: (chatKey) => {
        if (!memoryService?.enabled || !memoryBridgeServer) return undefined;
        const chatId = parseChatIdFromChatKey(chatKey);
        if (chatId === undefined) return undefined;
        const workspaceId = buildWorkspaceId(cwd);
        const userId = chatId > 0 ? chatId : undefined;
        return {
          PI_MEMORY_ENABLED: "1",
          PI_MEMORY_SOURCE: "telegram",
          PI_MEMORY_APP_VERSION: appVersion,
          PI_MEMORY_BRIDGE_VERSION: appVersion,
          PI_MEMORY_BRIDGE_PROTOCOL_VERSION: String(bridgeProtocolVersion),
          PI_MEMORY_BRIDGE_URL: memoryBridgeServer.url,
          PI_MEMORY_BRIDGE_TOKEN: memoryBridgeServer.token,
          PI_MEMORY_BOT_HASH: botKey,
          PI_MEMORY_BOT_NAME: botName,
          PI_MEMORY_CHAT_ID: String(chatId),
          PI_MEMORY_USER_ID: userId ? String(userId) : "",
          PI_MEMORY_WORKSPACE_CWD: cwd,
          PI_MEMORY_MAX_CONTEXT_CHARS: String(normalizedMemory.value.maxContextChars),
          PI_MEMORY_CHAT_SCOPE: `urn:pi-memory:scope:chat:telegram:${botKey}:${chatId}`,
          PI_MEMORY_USER_SCOPE: userId ? `urn:pi-memory:scope:user:telegram:${userId}` : "",
          PI_MEMORY_WORKSPACE_SCOPE: `urn:pi-memory:scope:workspace:${workspaceId}`,
        };
      },
    });
    pools.push(pool);

    const cronStorePath = resolve(cronRoot, botName, "jobs.json");
    const cronCfg = normalizedCron.value;
    const cron = new CronService({
      storePath: cronStorePath,
      botName,
      enabled: cronCfg.enabled,
      defaultTimezone: cronCfg.defaultTimezone,
      maxJobsPerChat: cronCfg.maxJobsPerChat,
      maxRunMs: cronCfg.maxRunSeconds * 1000,
      defaultPolicy: {
        maxLatenessMs: cronCfg.maxLatenessMs,
        retryMax: cronCfg.retryMax,
        retryBackoffMs: cronCfg.retryBackoffMs,
        deleteAfterRun: true,
      },
    });

    const bot = createBot({
      botIndex: i,
      config: botCfg,
      pool,
      cron,
      memory: memoryService,
      memoryTransport,
      maxResponseLength: config.maxResponseLength || 4000,
      initialStreamByChat: botCfg.streamByChat,
      onStreamModeChange: async (chatId, enabled) => {
        const key = String(chatId);
        const prev = botCfg.streamByChat?.[key];
        if (prev === enabled) return;

        botCfg.streamByChat = botCfg.streamByChat ?? {};
        botCfg.streamByChat[key] = enabled;

        try {
          await queueWriteSettings();
        } catch (err) {
          log.error("config", `保存流式配置失败 (${botCfg.name}:${key}=${enabled ? 1 : 0}): ${formatErr(err)}`);
          throw err;
        }
      },
    });

    await cron.start();
    cronServices.push(cron);

    const handle = startRunnerWithAutoRestart(bot, botName);
    bots.push(handle);
    log.boot(`"${botName}" started`);
  }

  if (needsSettingsRewrite) {
    queueWriteSettings().catch((err) => {
      log.error("config", `写回 settings.json 失败：${formatErr(err)}`);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.boot(`${bots.length} bot(s) running. Ctrl+C to stop.`);
}
