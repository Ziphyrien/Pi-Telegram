// src/app/config.ts — settings file creation, loading, normalization, and persistence
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { settingsPath, defaultWorkspace } from "./paths.js";
import type { AppConfig, CronConfig } from "../shared/types.js";

function getResolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function getDefaultCronConfig(): Required<CronConfig> {
  return {
    enabled: true,
    defaultTimezone: getResolvedTimezone(),
    maxJobsPerChat: 20,
    maxRunSeconds: 900,
    maxLatenessMs: 10 * 60 * 1000,
    retryMax: 2,
    retryBackoffMs: 30 * 1000,
  };
}

export function createDefaultSettingsTemplate(appVersion: string): AppConfig {
  const cron = getDefaultCronConfig();
  return {
    bots: [
      {
        token: "<YOUR_TELEGRAM_BOT_TOKEN>",
        name: "Pi-Telegram",
        allowedUsers: [],
        cwd: defaultWorkspace,
        streamByChat: {},
      },
    ],
    idleTimeoutMs: 600000,
    maxResponseLength: 4000,
    lastChangelogVersion: appVersion,
    cron,
  };
}

export function ensureSettingsFileExists(appVersion: string): boolean {
  if (existsSync(settingsPath)) return false;
  const template = createDefaultSettingsTemplate(appVersion);
  writeFileSync(settingsPath, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
  return true;
}

export function readAppConfig(): AppConfig {
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as AppConfig;
}

export function normalizeCronConfig(input: CronConfig | undefined): { value: Required<CronConfig>; changed: boolean } {
  const defaultCronConfig = getDefaultCronConfig();
  const src = input ?? {};
  let changed = input === undefined;

  const enabled = typeof src.enabled === "boolean" ? src.enabled : defaultCronConfig.enabled;
  if (enabled !== src.enabled) changed = true;

  const timezone = String(src.defaultTimezone || defaultCronConfig.defaultTimezone).trim() || defaultCronConfig.defaultTimezone;
  if (timezone !== src.defaultTimezone) changed = true;

  const maxJobsPerChatRaw = Number(src.maxJobsPerChat);
  const maxJobsPerChat = Number.isFinite(maxJobsPerChatRaw) && maxJobsPerChatRaw >= 1
    ? Math.floor(maxJobsPerChatRaw)
    : defaultCronConfig.maxJobsPerChat;
  if (maxJobsPerChat !== src.maxJobsPerChat) changed = true;

  const maxRunSecondsRaw = Number(src.maxRunSeconds);
  const maxRunSeconds = Number.isFinite(maxRunSecondsRaw) && maxRunSecondsRaw >= 10
    ? Math.floor(maxRunSecondsRaw)
    : defaultCronConfig.maxRunSeconds;
  if (maxRunSeconds !== src.maxRunSeconds) changed = true;

  const maxLatenessMsRaw = Number(src.maxLatenessMs);
  const maxLatenessMs = Number.isFinite(maxLatenessMsRaw) && maxLatenessMsRaw >= 0
    ? Math.floor(maxLatenessMsRaw)
    : defaultCronConfig.maxLatenessMs;
  if (maxLatenessMs !== src.maxLatenessMs) changed = true;

  const retryMaxRaw = Number(src.retryMax);
  const retryMax = Number.isFinite(retryMaxRaw) && retryMaxRaw >= 0
    ? Math.floor(retryMaxRaw)
    : defaultCronConfig.retryMax;
  if (retryMax !== src.retryMax) changed = true;

  const retryBackoffMsRaw = Number(src.retryBackoffMs);
  const retryBackoffMs = Number.isFinite(retryBackoffMsRaw) && retryBackoffMsRaw >= 1000
    ? Math.floor(retryBackoffMsRaw)
    : defaultCronConfig.retryBackoffMs;
  if (retryBackoffMs !== src.retryBackoffMs) changed = true;

  return {
    changed,
    value: {
      enabled,
      defaultTimezone: timezone,
      maxJobsPerChat,
      maxRunSeconds,
      maxLatenessMs,
      retryMax,
      retryBackoffMs,
    },
  };
}

export function normalizeStreamByChat(input: unknown): { value: Record<string, boolean>; changed: boolean } {
  const value: Record<string, boolean> = {};

  if (input === undefined) {
    return { value, changed: true };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value, changed: true };
  }

  let changed = false;
  for (const [chatIdRaw, enabledRaw] of Object.entries(input as Record<string, unknown>)) {
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId)) {
      changed = true;
      continue;
    }

    const key = String(chatId);
    if (key !== chatIdRaw) changed = true;

    if (typeof enabledRaw === "boolean") {
      value[key] = enabledRaw;
      continue;
    }

    if (enabledRaw === "true" || enabledRaw === "false") {
      value[key] = enabledRaw === "true";
      changed = true;
      continue;
    }

    if (typeof enabledRaw === "number") {
      value[key] = enabledRaw !== 0;
      changed = true;
      continue;
    }

    changed = true;
  }

  return { value, changed };
}

export function createSettingsWriter(config: AppConfig): () => Promise<void> {
  let settingsWriteQueue: Promise<void> = Promise.resolve();

  return () => {
    const task = settingsWriteQueue.then(() => {
      writeFileSync(settingsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    });

    settingsWriteQueue = task.catch(() => {
      // Keep queue chain alive for future writes.
    });

    return task;
  };
}
