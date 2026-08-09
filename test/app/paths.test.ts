import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// @covers app/paths.ts

describe("app paths", () => {
  test("derives telegram paths from the user home directory and creates app directories", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "pitg-home-"));

    process.env.HOME = home;
    process.env.USERPROFILE = home;

    try {
      const paths = await import(`../../src/app/paths.js?testHome=${encodeURIComponent(home)}-${Date.now()}`);

      assert.equal(paths.telegramRoot, resolve(home, ".pi", "telegram"));
      assert.equal(paths.settingsPath, resolve(home, ".pi", "telegram", "settings.json"));
      assert.equal(paths.sessionsRoot, resolve(home, ".pi", "telegram", "sessions"));
      assert.equal(paths.cronRoot, resolve(home, ".pi", "telegram", "cron"));
      assert.equal(paths.defaultWorkspace, resolve(home, ".pi", "telegram", "workspace"));

      paths.ensureAppDirectories();

      assert.equal(existsSync(paths.sessionsRoot), true);
      assert.equal(existsSync(paths.cronRoot), true);
      assert.equal(existsSync(paths.defaultWorkspace), true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;

      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});
