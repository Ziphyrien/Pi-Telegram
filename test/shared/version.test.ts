import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLatestVersion,
  compareVersions,
  getNewChangelogText,
  getNewEntries,
  getPackageDir,
  getPackageJsonPath,
  getPackageMeta,
  getUpdateInstruction,
  parseChangelog,
} from "../../src/shared/version.js";

// @covers shared/version.ts

describe("version helpers", () => {
  test("compares semantic versions and tolerates prefixes", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.ok(compareVersions("1.3.0", "1.2.9") > 0);
    assert.ok(compareVersions("v2.0.0", "10.0.0") < 0);
    assert.ok(compareVersions("not-a-version", "0.0.1") < 0);
  });

  test("parses changelog version sections", () => {
    const dir = mkdtempSync(join(tmpdir(), "pitg-version-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, [
      "# Changelog",
      "",
      "## [1.2.0]",
      "- Added feature",
      "",
      "## 1.1.0",
      "- Fixed bug",
      "",
      "## Unreleased",
      "- ignored",
    ].join("\n"));

    const entries = parseChangelog(changelog);

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(({ major, minor, patch }) => ({ major, minor, patch })), [
      { major: 1, minor: 2, patch: 0 },
      { major: 1, minor: 1, patch: 0 },
    ]);
    assert.match(entries[0].content, /Added feature/);
    assert.match(entries[1].content, /Fixed bug/);
  });

  test("returns entries newer than the last seen version", () => {
    const entries = [
      { major: 1, minor: 2, patch: 0, content: "1.2.0" },
      { major: 1, minor: 1, patch: 1, content: "1.1.1" },
      { major: 1, minor: 1, patch: 0, content: "1.1.0" },
    ];

    assert.deepEqual(getNewEntries(entries, "1.1.0").map((entry) => entry.content), ["1.2.0", "1.1.1"]);
    assert.deepEqual(getNewEntries(entries, "1.2.0"), []);
  });

  test("returns empty changelog entries for missing files", () => {
    assert.deepEqual(parseChangelog(join(tmpdir(), `missing-${Date.now()}.md`)), []);
  });

  test("reads package metadata and changelog text from PITG_PACKAGE_DIR", () => {
    const previous = process.env.PITG_PACKAGE_DIR;
    const dir = mkdtempSync(join(tmpdir(), "pitg-package-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "custom-pitg", version: "2.3.4" }), "utf-8");
    writeFileSync(join(dir, "CHANGELOG.md"), [
      "# Changelog",
      "",
      "## 2.3.4",
      "- Current",
      "",
      "## 2.0.0",
      "- Old",
    ].join("\n"));
    process.env.PITG_PACKAGE_DIR = dir;

    try {
      assert.equal(getPackageDir(), dir);
      assert.equal(getPackageJsonPath(), join(dir, "package.json"));
      assert.deepEqual(getPackageMeta(), { name: "custom-pitg", version: "2.3.4" });
      assert.match(getNewChangelogText("2.0.0") ?? "", /## 2\.3\.4/);
      assert.equal(getNewChangelogText("2.3.4"), undefined);
    } finally {
      if (previous === undefined) delete process.env.PITG_PACKAGE_DIR;
      else process.env.PITG_PACKAGE_DIR = previous;
    }
  });

  test("falls back to default package metadata when package.json cannot be read", () => {
    const previous = process.env.PITG_PACKAGE_DIR;
    process.env.PITG_PACKAGE_DIR = join(tmpdir(), `missing-package-${Date.now()}`);

    try {
      assert.deepEqual(getPackageMeta(), { name: "pi-telegram", version: "0.0.0" });
    } finally {
      if (previous === undefined) delete process.env.PITG_PACKAGE_DIR;
      else process.env.PITG_PACKAGE_DIR = previous;
    }
  });

  test("returns update instructions for the detected package manager", () => {
    assert.match(getUpdateInstruction("pi-telegram"), /^Run: (npm install -g|pnpm install -g|yarn global add|bun install -g) pi-telegram$/);
  });

  test("checks npm latest version with mocked fetch", async () => {
    const previousFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ version: "2.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      assert.equal(await checkLatestVersion("pkg name", "1.0.0"), "2.0.0");
      assert.equal(calls[0], "https://registry.npmjs.org/pkg%20name/latest");
      assert.equal(await checkLatestVersion("pkg", "2.0.0"), undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("returns undefined for failed or malformed latest-version responses", async () => {
    const previousFetch = globalThis.fetch;
    const responses = [
      new Response("not found", { status: 404 }),
      new Response(JSON.stringify({ version: "" }), { status: 200 }),
    ];
    globalThis.fetch = (async () => responses.shift() ?? Promise.reject(new Error("network"))) as unknown as typeof fetch;

    try {
      assert.equal(await checkLatestVersion("pkg", "1.0.0"), undefined);
      assert.equal(await checkLatestVersion("pkg", "1.0.0"), undefined);
      assert.equal(await checkLatestVersion("pkg", "1.0.0"), undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("compares versions embedded in prefixes and prerelease-like suffixes", () => {
    assert.equal(compareVersions("release-1.2.3-beta.9", "1.2.3"), 0);
    assert.ok(compareVersions("2026.05.17", "2025.12.31") > 0);
    assert.equal(compareVersions("1.2", "0.0.0"), 0);
  });

  test("parses changelog headings with dates and prerelease suffix text", () => {
    const dir = mkdtempSync(join(tmpdir(), "pitg-changelog-edge-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, [
      "# Changelog",
      "",
      "## [3.0.0] - 2026-01-01",
      "- Major",
      "",
      "## 2.1.0-beta.1",
      "- Beta text is grouped under 2.1.0",
      "",
      "## Version 2.0.0",
      "- ignored because heading does not start with numeric version",
      "",
    ].join("\n"));

    const entries = parseChangelog(changelog);

    assert.deepEqual(entries.map(({ major, minor, patch }) => ({ major, minor, patch })), [
      { major: 3, minor: 0, patch: 0 },
      { major: 2, minor: 1, patch: 0 },
    ]);
    assert.match(entries[0].content, /2026-01-01/);
    assert.match(entries[1].content, /Beta text/);
  });

  test("filters new entries when last version contains a prefix", () => {
    const entries = [
      { major: 2, minor: 0, patch: 0, content: "2.0.0" },
      { major: 1, minor: 9, patch: 9, content: "1.9.9" },
    ];

    assert.deepEqual(getNewEntries(entries, "v1.9.9").map((entry) => entry.content), ["2.0.0"]);
    assert.deepEqual(getNewEntries(entries, "not-a-version").map((entry) => entry.content), ["2.0.0", "1.9.9"]);
  });

  test("expands tilde package directories from environment", () => {
    const previousPitg = process.env.PITG_PACKAGE_DIR;
    const previousPi = process.env.PI_PACKAGE_DIR;

    try {
      process.env.PITG_PACKAGE_DIR = "~";
      delete process.env.PI_PACKAGE_DIR;
      assert.equal(getPackageDir(), homedir());

      process.env.PITG_PACKAGE_DIR = "~/custom-pitg";
      assert.equal(getPackageDir(), `${homedir()}/custom-pitg`);
    } finally {
      if (previousPitg === undefined) delete process.env.PITG_PACKAGE_DIR;
      else process.env.PITG_PACKAGE_DIR = previousPitg;
      if (previousPi === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = previousPi;
    }
  });

  test("uses default package metadata fields independently", () => {
    const previous = process.env.PITG_PACKAGE_DIR;
    const dir = mkdtempSync(join(tmpdir(), "pitg-package-partial-"));
    process.env.PITG_PACKAGE_DIR = dir;

    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "custom-only" }), "utf-8");
      assert.deepEqual(getPackageMeta(), { name: "custom-only", version: "0.0.0" });

      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.8.7" }), "utf-8");
      assert.deepEqual(getPackageMeta(), { name: "pi-telegram", version: "9.8.7" });
    } finally {
      if (previous === undefined) delete process.env.PITG_PACKAGE_DIR;
      else process.env.PITG_PACKAGE_DIR = previous;
    }
  });

  test("returns undefined for invalid latest-version JSON", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{not-json", { status: 200 })) as unknown as typeof fetch;

    try {
      assert.equal(await checkLatestVersion("pkg", "1.0.0"), undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
