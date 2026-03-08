// src/app/paths.ts — runtime path constants and bootstrap helpers
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const telegramRoot = resolve(homedir(), ".pi", "telegram");
export const settingsPath = resolve(telegramRoot, "settings.json");
export const sessionsRoot = resolve(telegramRoot, "sessions");
export const cronRoot = resolve(telegramRoot, "cron");
export const memoryRoot = resolve(telegramRoot, "memory");
export const defaultMemoryStorePath = resolve(memoryRoot, "memory.db");
export const defaultWorkspace = resolve(telegramRoot, "workspace");

export function ensureAppDirectories(): void {
  mkdirSync(sessionsRoot, { recursive: true });
  mkdirSync(cronRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  mkdirSync(defaultWorkspace, { recursive: true });
}
