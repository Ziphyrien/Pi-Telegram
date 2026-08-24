import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// @covers settings.ts

const realOs = await import("node:os");

describe("settings paths", () => {
  test("derives telegram paths from the user home directory and creates app directories", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitg-home-"));

    mock.module("node:os", () => ({ ...realOs, homedir: () => home }));

    const paths = await import(`../../src/settings.js?testHome=${encodeURIComponent(home)}-${Date.now()}`);

      assert.equal(paths.telegramRoot, resolve(home, ".pi", "telegram"));
      assert.equal(paths.settingsPath, resolve(home, ".pi", "telegram", "settings.json"));
      assert.equal(paths.sessionsRoot, resolve(home, ".pi", "telegram", "sessions"));
      assert.equal(paths.cronRoot, resolve(home, ".pi", "telegram", "cron"));
      assert.equal(paths.defaultWorkspace, resolve(home, ".pi", "telegram", "workspace"));

      paths.ensureAppDirectories();

      assert.equal(existsSync(paths.sessionsRoot), true);
      assert.equal(existsSync(paths.cronRoot), true);
    assert.equal(existsSync(paths.defaultWorkspace), true);
  });
});
