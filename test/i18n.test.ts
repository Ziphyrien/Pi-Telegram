import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { en } from "../src/i18n/en.js";
import { detectLanguage, getLanguage, setLanguage, t } from "../src/i18n.js";

// @covers i18n.ts, i18n/en.ts

describe("i18n", () => {
  test("zh (default) returns keys unchanged, preserving legacy behavior", () => {
    setLanguage("zh");
    assert.equal(t("查看状态"), "查看状态");
    assert.equal(t("✅ 已创建任务 "), "✅ 已创建任务 ");
    assert.equal(t("missing-key"), "missing-key");
  });

  test("en returns translations from the dictionary", () => {
    setLanguage("en");
    assert.equal(t("查看状态"), "View status");
    assert.equal(t("✅ 已创建任务 "), "✅ Task created ");
    assert.equal(t("🆕 已新建会话"), "🆕 New session created");
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

  test("detectLanguage falls back to the system locale", () => {
    const previousLang = process.env.LANG;
    const previousAll = process.env.LC_ALL;
    try {
      delete process.env.LC_ALL;
      process.env.LANG = "zh_CN.UTF-8";
      assert.equal(detectLanguage(), "zh");
      process.env.LANG = "en_US.UTF-8";
      assert.equal(detectLanguage(), "en");
      process.env.LANG = "fr_FR.UTF-8";
      assert.equal(detectLanguage(), "en");
      delete process.env.LANG;
      assert.equal(detectLanguage(), "en");
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousAll;
    }
  });

  test("en dictionary covers every t() key used in src", async () => {
    // Collect every t("...") call site from the source, evaluate it as a real
    // TS string, and require a matching dictionary entry (keys are the raw
    // Chinese strings, so a match means the translation exists).
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "..", "src");
    const files = await readdir(root, { recursive: true });
    const tsFiles = files.filter((f) => f.endsWith(".ts"));

    const callSite = /(?<![A-Za-z0-9_])t\("((?:[^"\\]|\\.)*)"\)/g;
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
    assert.deepEqual(missing, [], `missing English translations for: ${missing.join(", ")}`);
  });

  test("getLanguage reflects setLanguage", () => {
    setLanguage("en");
    assert.equal(getLanguage(), "en");
    setLanguage("zh");
    assert.equal(getLanguage(), "zh");
  });
});
