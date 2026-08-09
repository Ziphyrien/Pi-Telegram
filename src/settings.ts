import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { AppConfig, CronConfig } from "./types.js";
export type { AppConfig, BotConfig, CronConfig } from "./types.js";

export const telegramRoot = resolve(homedir(), ".pi", "telegram");
export const settingsPath = resolve(telegramRoot, "settings.json");
export const sessionsRoot = resolve(telegramRoot, "sessions");
export const cronRoot = resolve(telegramRoot, "cron");
export const defaultWorkspace = resolve(telegramRoot, "workspace");

export function ensureAppDirectories(): void {
  for (const directory of [sessionsRoot, cronRoot, defaultWorkspace]) {
    mkdirSync(directory, { recursive: true });
  }
}

type NormalizationResult<T> = { value: T; changed: boolean };

export function getDefaultCronConfig(): Required<CronConfig> {
  return {
    enabled: true,
    defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    maxJobsPerChat: 20,
    maxRunSeconds: 900,
    maxLatenessMs: 10 * 60 * 1000,
    retryMax: 2,
    retryBackoffMs: 30 * 1000,
  };
}

export function createDefaultSettingsTemplate(appVersion: string): AppConfig {
  return {
    bots: [{
      token: "<YOUR_TELEGRAM_BOT_TOKEN>",
      name: "Pi-Telegram",
      allowedUsers: [],
      cwd: defaultWorkspace,
      streamByChat: {},
    }],
    idleTimeoutMs: 600000,
    maxResponseLength: 4000,
    lastChangelogVersion: appVersion,
    cron: getDefaultCronConfig(),
  };
}

export function ensureSettingsFileExists(appVersion: string): boolean {
  if (existsSync(settingsPath)) return false;
  writeFileSync(settingsPath, `${JSON.stringify(createDefaultSettingsTemplate(appVersion), null, 2)}\n`, "utf-8");
  return true;
}

export function readAppConfig(): AppConfig {
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as AppConfig;
}

const CRON_NUMBER_RULES = [
  ["maxJobsPerChat", 1],
  ["maxRunSeconds", 10],
  ["maxLatenessMs", 0],
  ["retryMax", 0],
  ["retryBackoffMs", 1000],
] as const;

type CronNumberKey = (typeof CRON_NUMBER_RULES)[number][0];

function normalizeInteger(raw: unknown, minimum: number, fallback: number): NormalizationResult<number> {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
  return { value, changed: value !== raw };
}

export function normalizeCronConfig(input: CronConfig | undefined): NormalizationResult<Required<CronConfig>> {
  const defaults = getDefaultCronConfig();
  const source = input ?? {};
  let changed = input === undefined;

  const enabled = typeof source.enabled === "boolean" ? source.enabled : defaults.enabled;
  changed ||= enabled !== source.enabled;
  const defaultTimezone = String(source.defaultTimezone || defaults.defaultTimezone).trim() || defaults.defaultTimezone;
  changed ||= defaultTimezone !== source.defaultTimezone;

  const values = {} as Record<CronNumberKey, number>;
  for (const [key, minimum] of CRON_NUMBER_RULES) {
    const normalized = normalizeInteger(source[key], minimum, defaults[key]);
    values[key] = normalized.value;
    changed ||= normalized.changed;
  }

  return { changed, value: { enabled, defaultTimezone, ...values } };
}

function normalizeStreamValue(raw: unknown): NormalizationResult<boolean> | undefined {
  if (typeof raw === "boolean") return { value: raw, changed: false };
  if (raw === "true" || raw === "false") return { value: raw === "true", changed: true };
  if (typeof raw === "number") return { value: raw !== 0, changed: true };
  return undefined;
}

export function normalizeStreamByChat(input: unknown): NormalizationResult<Record<string, boolean>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value: {}, changed: true };

  const value: Record<string, boolean> = {};
  let changed = false;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const chatId = Number(rawKey);
    if (!Number.isSafeInteger(chatId)) {
      changed = true;
      continue;
    }

    const key = String(chatId);
    if (key !== rawKey) changed = true;
    const normalized = normalizeStreamValue(rawValue);
    if (!normalized) {
      changed = true;
      continue;
    }
    value[key] = normalized.value;
    changed ||= normalized.changed;
  }
  return { value, changed };
}

export function createSettingsWriter(config: AppConfig): () => Promise<void> {
  let pendingWrite: Promise<void> = Promise.resolve();
  return () => {
    const write = pendingWrite.then(() => {
      writeFileSync(settingsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    });
    pendingWrite = write.catch(() => undefined);
    return write;
  };
}
