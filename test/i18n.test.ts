import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { en } from "../src/i18n/en.js";
import { detectLanguage, getLanguage, setLanguage, t } from "../src/i18n.js";

// @covers i18n.ts, i18n/en.ts

const localeEnvironmentKeys = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] as const;
const originalLocaleEnvironment = Object.fromEntries(
  localeEnvironmentKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof localeEnvironmentKeys)[number], string | undefined>;
const originalDateTimeFormat = Intl.DateTimeFormat;

function clearLocaleEnvironment(): void {
  for (const key of localeEnvironmentKeys) delete process.env[key];
}

afterEach(() => {
  for (const key of localeEnvironmentKeys) {
    const value = originalLocaleEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Intl.DateTimeFormat = originalDateTimeFormat;
  setLanguage("zh");
});

describe("i18n", () => {
  test("zh (default) returns keys unchanged, preserving legacy behavior", () => {
    setLanguage("zh");
    assert.equal(t("查看状态"), "查看状态");
    assert.equal(t("✅ 任务 {id} 已启用", { id: "abcd1234" }), "✅ 任务 abcd1234 已启用");
    assert.equal(t("missing-key"), "missing-key");
  });

  test("en returns translations from the dictionary", () => {
    setLanguage("en");
    assert.equal(t("查看状态"), "View status");
    assert.equal(t("✅ 任务 {id} 已启用", { id: "abcd1234" }), "✅ Task abcd1234 enabled");
    assert.equal(t("🆕 已新建会话"), "🆕 New session created");
  });

  test("interpolates variables after selecting the active translation", () => {
    setLanguage("en");
    assert.equal(t("✅ 任务 {id} 已启用", { id: "abcd1234" }), "✅ Task abcd1234 enabled");
    assert.equal(t("✅ 任务 {id} 已{state}", { id: "abcd1234", state: t("启用") }), "✅ Task abcd1234 enabled");
    assert.equal(t("missing {value}", { value: 42 }), "missing 42");
    assert.equal(t("unknown {value}"), "unknown {value}");

    setLanguage("zh");
    assert.equal(t("✅ 任务 {id} 已启用", { id: "abcd1234" }), "✅ 任务 abcd1234 已启用");
    assert.equal(t("✅ 任务 {id} 已{state}", { id: "abcd1234", state: t("启用") }), "✅ 任务 abcd1234 已启用");
  });

  test("en falls back to the key for missing translations", () => {
    setLanguage("en");
    assert.equal(t("not-in-the-dictionary"), "not-in-the-dictionary");
  });

  test("every dictionary value is a string", () => {
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof value, "string", `en[${key}] is not a string`);
    }
  });

  test("detectLanguage honors explicit values", () => {
    assert.equal(detectLanguage("zh"), "zh");
    assert.equal(detectLanguage("en"), "en");
  });

  test("detectLanguage follows locale environment precedence", () => {
    clearLocaleEnvironment();
    process.env.LANGUAGE = "zh_CN.UTF-8";
    assert.equal(detectLanguage(), "zh");

    process.env.LANG = "en_US.UTF-8";
    assert.equal(detectLanguage(), "en");

    process.env.LC_MESSAGES = "zh_TW.UTF-8";
    assert.equal(detectLanguage(), "zh");

    process.env.LC_ALL = "en_GB.UTF-8";
    assert.equal(detectLanguage(), "en");

    process.env.LC_ALL = "";
    assert.equal(detectLanguage(), "zh");

    process.env.LC_MESSAGES = "fr_FR.UTF-8";
    process.env.LANG = "zh_CN.UTF-8";
    assert.equal(detectLanguage(), "en");

    clearLocaleEnvironment();
    process.env.LANGUAGE = "fr_FR.UTF-8:zh_CN.UTF-8:en_US.UTF-8";
    assert.equal(detectLanguage(), "en");
  });

  test("detectLanguage falls back to the Intl system locale", () => {
    clearLocaleEnvironment();
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const expected = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    assert.equal(detectLanguage(), expected);
  });

  test("detectLanguage uses a Chinese Intl locale when environment variables are absent", () => {
    clearLocaleEnvironment();
    Intl.DateTimeFormat = (() => ({
      resolvedOptions: () => ({ locale: "zh-CN" }),
    })) as typeof Intl.DateTimeFormat;

    assert.equal(detectLanguage(), "zh");
  });

  test("en dictionary exactly matches every t() key used in src", async () => {
    // Collect every t("...") call site from the source, evaluate it as a real
    // TS string, and require a matching dictionary entry (keys are the raw
    // Chinese strings, so a match means the translation exists).
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "..", "src");
    const files = await readdir(root, { recursive: true });
    const tsFiles = files.filter((file) => file.endsWith(".ts"));

    const callSite = /(?<![A-Za-z0-9_])t\("((?:[^"\\]|\\.)*)"/g;
    const seen = new Set<string>();
    for (const file of tsFiles) {
      const source = await readFile(join(root, file), "utf-8");
      for (const match of source.matchAll(callSite)) {
        // Reconstruct the TS string literal verbatim (match[1] is already a
        // valid string body) and evaluate it to get the real runtime key.
        // eslint-disable-next-line no-eval -- keys are static literals from this repo
        const key = Function(`"use strict"; return ("${match[1]}");`)();
        seen.add(key);
      }
    }
    const missing = [...seen].filter((key) => !(key in en));
    const stale = Object.keys(en).filter((key) => !seen.has(key));
    assert.deepEqual(missing, [], `missing English translations for: ${missing.join(", ")}`);
    assert.deepEqual(stale, [], `stale English translations for: ${stale.join(", ")}`);
  });

  test("getLanguage reflects setLanguage", () => {
    setLanguage("en");
    assert.equal(getLanguage(), "en");
    setLanguage("zh");
    assert.equal(getLanguage(), "zh");
  });
});
