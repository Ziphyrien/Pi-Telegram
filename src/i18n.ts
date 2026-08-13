// Lightweight i18n for Pi-Telegram.
//
// Keys are the original Chinese strings: t() returns the English translation
// when the "en" language is active, and falls back to the key itself (the
// original Chinese text) otherwise. This keeps the default behavior identical
// to the pre-i18n build and guarantees that a missing dictionary entry can
// never break a message.
import { en } from "./i18n/en.js";

export type Language = "zh" | "en";
export type TranslationVariables = Readonly<Record<string, string | number | boolean | undefined>>;

let currentLanguage: Language = "zh";

function languageFromLocale(value: string | undefined | null): Language | undefined {
  const locale = value?.trim().replaceAll("_", "-").toLowerCase();
  if (!locale) return undefined;
  return locale === "zh" || locale.startsWith("zh-") ? "zh" : "en";
}

function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

function interpolate(text: string, variables: TranslationVariables): string {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(variables, name)) return placeholder;
    return String(variables[name] ?? "");
  });
}

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
 * 2. locale environment variables (LC_ALL / LC_MESSAGES / LANG / LANGUAGE)
 * 3. the OS locale exposed by Intl (important on Windows)
 * 4. fallback: "en" (non-Chinese or undetectable locales)
 */
export function detectLanguage(explicit?: string): Language {
  if (explicit === "zh" || explicit === "en") return explicit;

  const localeCandidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    process.env.LANGUAGE,
    systemLocale(),
  ];
  for (const candidate of localeCandidates) {
    for (const value of candidate?.split(":") ?? []) {
      const language = languageFromLocale(value);
      if (language) return language;
    }
  }
  return "en";
}

/** Translate a key and interpolate `{name}` placeholders. */
export function t(key: string, variables: TranslationVariables = {}): string {
  const value = currentLanguage === "en" ? en[key] ?? key : key;
  return interpolate(value, variables);
}
