// Lightweight i18n for Pi-Telegram.
//
// Keys are the original Chinese strings: t() returns the English translation
// when the "en" language is active, and falls back to the key itself (the
// original Chinese text) otherwise. This keeps the default behavior identical
// to the pre-i18n build and guarantees that a missing dictionary entry can
// never break a message.
import { en } from "./i18n/en.js";

export type Language = "zh" | "en";

let currentLanguage: Language = "zh";

/** Set the active language at startup (see detectLanguage). */
export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

/** Current active language. */
export function getLanguage(): Language {
  return currentLanguage;
}

/**
 * Resolve the language to use:
 * 1. explicit `language` value from settings.json ("zh" | "en")
 * 2. system locale (LANG / LC_ALL): Chinese locales -> zh, everything else -> en
 * 3. fallback: "en" (non-Chinese or undetectable locales)
 */
export function detectLanguage(explicit?: string): Language {
  if (explicit === "zh" || explicit === "en") return explicit;
  const locale = (process.env.LC_ALL ?? process.env.LANG ?? "").toLowerCase();
  if (locale.startsWith("zh")) return "zh";
  return "en";
}

/** Translate a key. Falls back to the key itself when no translation exists. */
export function t(key: string): string {
  if (currentLanguage === "en") {
    return en[key] ?? key;
  }
  return key;
}
