import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// @covers app/config.ts

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), "pitg-config-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const paths = await import("../../src/app/paths.js");
const config = await import("../../src/app/config.js");

process.on("exit", () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
});

describe("app config file I/O", () => {
  test("creates a settings file only when it is missing", () => {
    paths.ensureAppDirectories();

    assert.equal(config.ensureSettingsFileExists("9.9.9"), true);
    assert.equal(existsSync(paths.settingsPath), true);
    const created = JSON.parse(readFileSync(paths.settingsPath, "utf-8"));
    assert.equal(created.lastChangelogVersion, "9.9.9");
    assert.equal(created.bots[0].cwd, resolve(home, ".pi", "telegram", "workspace"));
    assert.equal(config.ensureSettingsFileExists("10.0.0"), false);
    assert.equal(JSON.parse(readFileSync(paths.settingsPath, "utf-8")).lastChangelogVersion, "9.9.9");
  });

  test("reads app config and serializes queued settings writes", async () => {
    const appConfig = config.createDefaultSettingsTemplate("1.0.0");
    writeFileSync(paths.settingsPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf-8");

    const loaded = config.readAppConfig();
    assert.equal(loaded.lastChangelogVersion, "1.0.0");

    const writer = config.createSettingsWriter(loaded);
    loaded.maxResponseLength = 1234;
    await writer();
    loaded.maxResponseLength = 5678;
    await writer();

    const saved = JSON.parse(readFileSync(paths.settingsPath, "utf-8"));
    assert.equal(saved.maxResponseLength, 5678);
  });

  test("settings writer recovers after a failed queued write", async () => {
    const appConfig = config.createDefaultSettingsTemplate("2.0.0");
    const writer = config.createSettingsWriter(appConfig);
    rmSync(paths.settingsPath, { force: true, recursive: true });
    mkdirSync(paths.settingsPath);

    await assert.rejects(
      () => writer(),
      (err: unknown) => ["EISDIR", "EEXIST", "EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? ""),
    );

    rmSync(paths.settingsPath, { force: true, recursive: true });
    appConfig.maxResponseLength = 2468;
    await writer();

    const saved = JSON.parse(readFileSync(paths.settingsPath, "utf-8"));
    assert.equal(saved.lastChangelogVersion, "2.0.0");
    assert.equal(saved.maxResponseLength, 2468);
  });
});
