import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { AgentPool } from "./agent.js";
import { Scheduler } from "./scheduler.js";
import { detectLanguage, setLanguage, t } from "./i18n.js";
import { createBot } from "./telegram/bot.js";
import { getRegisteredToolSystemPrompt } from "./telegram/presentation.js";
import { log } from "./platform/logger.js";
import {
  checkLatestVersion,
  getNewChangelogText,
  getPackageMeta,
  getUpdateInstruction,
  shouldCheckUpdatesOnStartup,
} from "./platform/version.js";
import {
  createSettingsWriter,
  ensureAppDirectories,
  ensureSettingsFileExists,
  normalizeCronConfig,
  normalizeLanguage,
  normalizeStreamByChat,
  readAppConfig,
  cronRoot,
  defaultWorkspace,
  sessionsRoot,
  settingsPath,
  telegramRoot,
  type AppConfig,
  type BotConfig,
} from "./settings.js";

interface ManagedRunner {
  stop(): Promise<void>;
}

class RuntimeResources {
  readonly runners: ManagedRunner[] = [];
  readonly pools: AgentPool[] = [];
  readonly schedulers: Scheduler[] = [];
  stopping = false;

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.shutdown("stopping...");
    for (const runner of this.runners) await runner.stop();
    for (const scheduler of this.schedulers) await scheduler.stop();
    for (const pool of this.pools) await pool.shutdown();
    process.exit(0);
  }
}

const resources = new RuntimeResources();
let booted = false;

export function formatErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getTelegramErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).error_code;
  return typeof code === "number" ? code : undefined;
}

export function describeRunnerError(error: unknown): string {
  const details = [formatErr(error)];
  if (!error || typeof error !== "object") return details.join(" | ");

  const record = error as Record<string, unknown>;
  if (typeof record.error_code === "number") details.push(`error_code=${record.error_code}`);
  if (typeof record.description === "string" && record.description.trim()) {
    details.push(`description=${record.description}`);
  }
  const parameters = record.parameters;
  if (parameters && typeof parameters === "object") {
    const retryAfter = (parameters as Record<string, unknown>).retry_after;
    if (typeof retryAfter === "number") details.push(`retry_after=${retryAfter}s`);
  }
  return details.join(" | ");
}

function startTelegramRunner(bot: ReturnType<typeof createBot>, botName: string): ManagedRunner {
  let runner: RunnerHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRestart = (reason: string, delayMs = 5000): void => {
    if (resources.stopping || retryTimer) return;
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    log.warn(t("\"{botName}\" 轮询已停止（{reason}），{seconds} 秒后重试", { botName, reason, seconds }));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      log.warn(t("\"{botName}\" 正在重启 Telegram 轮询...", { botName }));
      start();
    }, delayMs);
  };

  const watch = (current: RunnerHandle): void => {
    const task = current.task();
    if (!task) return;
    task.then(
      () => {
        if (!resources.stopping && runner === current) scheduleRestart("runner task ended");
      },
      (error) => {
        if (resources.stopping || runner !== current) return;
        const code = getTelegramErrorCode(error);
        log.error("boot", t("\"{botName}\" 轮询异常：{message}", { botName, message: describeRunnerError(error) }));
        if (code === 401) {
          log.warn(t("\"{botName}\" token 可能无效/已失效，请检查 settings.json（本次不自动重启）", { botName }));
          return;
        }
        if (code === 409) {
          log.warn(t("\"{botName}\" 可能存在重复实例（同 token 多进程轮询）", { botName }));
          scheduleRestart("runner crashed code=409", 15_000);
          return;
        }
        scheduleRestart(code ? `runner crashed code=${code}` : "runner crashed");
      },
    );
  };

  const start = (): void => {
    if (resources.stopping) return;
    try {
      runner = run(bot, { runner: { maxRetryTime: 7 * 24 * 60 * 60 * 1000 } });
      watch(runner);
    } catch (error) {
      log.error("boot", t("\"{botName}\" 启动轮询失败：{message}", { botName, message: describeRunnerError(error) }));
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
      if (runner?.isRunning()) await runner.stop();
    },
  };
}

function prepareSystemPrompt(): string {
  const prompt = getRegisteredToolSystemPrompt().trim();
  if (!prompt) return "";
  const path = resolve(telegramRoot, "tool-system-prompt.txt");
  writeFileSync(path, `${prompt}\n`, "utf-8");
  return path;
}

function refreshChangelogVersion(config: AppConfig, appVersion: string): boolean {
  if (!config.lastChangelogVersion) {
    config.lastChangelogVersion = appVersion;
    return true;
  }
  if (config.lastChangelogVersion === appVersion) return false;

  const changelog = getNewChangelogText(config.lastChangelogVersion);
  if (changelog) {
    log.warn(t("检测到新版本变更（{from} -> {to}）：", { from: config.lastChangelogVersion, to: appVersion }));
    for (const line of changelog.split(/\r?\n/)) if (line.trim()) log.warn(line);
  }
  config.lastChangelogVersion = appVersion;
  return true;
}

function normalizeBotStreams(bot: BotConfig): boolean {
  const hadValue = Object.prototype.hasOwnProperty.call(bot, "streamByChat");
  const normalized = normalizeStreamByChat(bot.streamByChat);
  bot.streamByChat = normalized.value;
  return !hadValue || normalized.changed;
}

export async function runApp(): Promise<void> {
  if (booted) return;
  booted = true;
  ensureAppDirectories();

  const { name: packageName, version: appVersion } = getPackageMeta();
  // Activate the auto-detected language before any user-facing bootstrap logs
  // (first-run warnings below run before the config file is available).
  setLanguage(detectLanguage());
  if (ensureSettingsFileExists(appVersion)) {
    log.warn(t("settings.json 不存在，已自动生成模板: {path}", { path: settingsPath }));
    log.warn(t("请先填写 bot token，再重新启动。\n"));
    process.exit(1);
    return;
  }

  const config = readAppConfig();
  const language = normalizeLanguage(config.language);
  config.language = language.value;
  setLanguage(detectLanguage(config.language));
  let rewriteSettings = refreshChangelogVersion(config, appVersion) || language.changed;
  log.boot(`Pi-Telegram v${appVersion}`);

  if (shouldCheckUpdatesOnStartup()) {
    void checkLatestVersion(packageName, appVersion).then((version) => {
      if (!version) return;
      log.warn(t("发现新版本 {version} 可用。{instruction}", { version, instruction: getUpdateInstruction(packageName) }));
      log.warn("Changelog: https://github.com/Ziphyrien/Pi-Telegram/blob/main/CHANGELOG.md");
    });
  }

  const cron = normalizeCronConfig(config.cron);
  config.cron = cron.value;
  rewriteSettings ||= cron.changed;
  const writeSettings = createSettingsWriter(config);
  const systemPromptPath = prepareSystemPrompt();

  for (const [index, botConfig] of config.bots.entries()) {
    rewriteSettings ||= normalizeBotStreams(botConfig);
    const botName = botConfig.name || `bot${index}`;
    const pool = new AgentPool({
      cwd: botConfig.cwd || defaultWorkspace,
      piArgs: [],
      appendSystemPrompt: systemPromptPath,
      sessionBaseDir: resolve(sessionsRoot, botName),
      idleTimeoutMs: config.idleTimeoutMs || 600_000,
    });
    resources.pools.push(pool);

    const scheduler = new Scheduler({
      storePath: resolve(cronRoot, botName, "jobs.json"),
      botName,
      enabled: cron.value.enabled,
      defaultTimezone: cron.value.defaultTimezone,
      maxJobsPerChat: cron.value.maxJobsPerChat,
      maxRunMs: cron.value.maxRunSeconds * 1000,
      defaultPolicy: {
        maxLatenessMs: cron.value.maxLatenessMs,
        retryMax: cron.value.retryMax,
        retryBackoffMs: cron.value.retryBackoffMs,
        deleteAfterRun: true,
      },
    });

    const bot = createBot({
      botIndex: index,
      config: botConfig,
      pool,
      cron: scheduler,
      maxResponseLength: config.maxResponseLength || 4000,
      initialStreamByChat: botConfig.streamByChat,
      onStreamModeChange: async (chatId, enabled) => {
        const key = String(chatId);
        if (botConfig.streamByChat?.[key] === enabled) return;
        botConfig.streamByChat ??= {};
        botConfig.streamByChat[key] = enabled;
        try {
          await writeSettings();
        } catch (error) {
          log.error("config", t("保存流式配置失败 ({botName}:{chatId}={enabled}): {message}", {
            botName,
            chatId: key,
            enabled: enabled ? 1 : 0,
            message: formatErr(error),
          }));
          throw error;
        }
      },
    });

    await scheduler.start();
    resources.schedulers.push(scheduler);
    resources.runners.push(startTelegramRunner(bot, botName));
    log.boot(`"${botName}" started`);
  }

  if (rewriteSettings) {
    writeSettings().catch((error) => log.error("config", t("写回 settings.json 失败：{message}", { message: formatErr(error) })));
  }

  process.on("SIGINT", () => void resources.shutdown());
  process.on("SIGTERM", () => void resources.shutdown());
  log.boot(`${resources.runners.length} bot(s) running. Ctrl+C to stop.`);
}
