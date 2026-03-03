#!/usr/bin/env node
/**
 * Release script for pi-telegram
 *
 * Preferred usage:
 *   node scripts/release.mjs
 *
 * Optional:
 *   node scripts/release.mjs --version <x.y.z>
 *
 * Default behavior resolves target version from CHANGELOG.md:
 * - Read the first release heading like: ## [x.y.z] - YYYY-MM-DD
 * - Then sync package.json version to that value
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, rmSync } from "fs";

const args = process.argv.slice(2);

let explicitVersion = "";
if (args.length === 0) {
  // Use version from changelog.
} else if (args.length === 2 && args[0] === "--version") {
  explicitVersion = String(args[1] || "").trim();
} else {
  console.error("Usage: node scripts/release.mjs [--version <x.y.z>]");
  process.exit(1);
}

function run(cmd, options = {}) {
  console.log(`$ ${cmd}`);
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
  } catch (e) {
    if (!options.ignoreError) {
      console.error(`Command failed: ${cmd}`);
      process.exit(1);
    }
    return null;
  }
}

function isSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || "").trim());
}

function getPackageVersion() {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  return String(pkg.version || "0.0.0").trim();
}

function getChangelogPath() {
  const changelog = "CHANGELOG.md";
  if (!existsSync(changelog)) {
    console.error("Error: CHANGELOG.md not found in project root.");
    process.exit(1);
  }
  return changelog;
}

function getTopReleaseVersionFromChangelog() {
  const changelog = getChangelogPath();
  const content = readFileSync(changelog, "utf-8");

  if (!content.includes("## [Unreleased]")) {
    console.error(`Error: ${changelog} has no [Unreleased] section`);
    process.exit(1);
  }

  // Match release headings like: ## [1.2.3] - 2026-03-03
  const re = /^##\s+\[(\d+\.\d+\.\d+)\](?:\s+-\s+.+)?\s*$/gm;
  const m = re.exec(content);
  if (!m) {
    console.error("Error: no release version heading found in CHANGELOG.md");
    console.error("Expected a line like: ## [x.y.z] - YYYY-MM-DD");
    process.exit(1);
  }

  return m[1];
}

function getDirtyPaths() {
  const raw = run("git status --porcelain", { silent: true }) || "";
  const lines = raw.split(/\r?\n/).map((x) => x.trimEnd()).filter(Boolean);

  return lines.map((line) => {
    // Format: XY <path>
    const m = line.match(/^..\s+(.+)$/);
    const body = m ? m[1] : line;
    // Handle rename: old -> new
    const parts = body.split(" -> ");
    return (parts[parts.length - 1] || "").trim();
  });
}

function assertWorkingTreeAllowed() {
  const dirty = getDirtyPaths();
  if (!dirty.length) return;

  const allowed = new Set(["CHANGELOG.md"]);
  const blocked = dirty.filter((p) => !allowed.has(p));

  if (blocked.length) {
    console.error("Error: Uncommitted changes detected (only CHANGELOG.md is allowed before release):");
    for (const p of blocked) console.error(` - ${p}`);
    process.exit(1);
  }
}

function tagExists(version) {
  const out = run(`git rev-parse -q --verify refs/tags/v${version}`, {
    silent: true,
    ignoreError: true,
  });
  return !!(out && out.trim());
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

function hasCommand(command) {
  try {
    execSync(`${command} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectPackageManager() {
  if (existsSync("pnpm-lock.yaml") && hasCommand("pnpm")) return "pnpm";
  if (existsSync("yarn.lock") && hasCommand("yarn")) return "yarn";
  if ((existsSync("bun.lockb") || existsSync("bun.lock")) && hasCommand("bun")) return "bun";
  return "npm";
}

function reinstallDependenciesFromScratch() {
  const manager = detectPackageManager();
  const lockFiles = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "npm-shrinkwrap.json",
  ];

  console.log(`Resetting dependencies from scratch (manager=${manager})...`);

  if (existsSync("node_modules")) {
    rmSync("node_modules", { recursive: true, force: true });
    console.log("  Removed node_modules");
  }

  for (const lock of lockFiles) {
    if (!existsSync(lock)) continue;
    rmSync(lock, { force: true });
    console.log(`  Removed ${lock}`);
  }

  if (manager === "pnpm") {
    run("pnpm install");
  } else if (manager === "yarn") {
    run("yarn install");
  } else if (manager === "bun") {
    run("bun install");
  } else {
    run("npm install");
  }

  console.log("  Dependencies reinstalled\n");
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check working tree (allow CHANGELOG only)
console.log("Checking working tree...");
assertWorkingTreeAllowed();
console.log("  Working tree is ready\n");

// 2. Resolve target version
const targetVersion = explicitVersion || getTopReleaseVersionFromChangelog();
if (!isSemver(targetVersion)) {
  console.error(`Error: invalid version: ${targetVersion}`);
  process.exit(1);
}

if (tagExists(targetVersion)) {
  console.error(`Error: tag v${targetVersion} already exists.`);
  process.exit(1);
}

const currentVersion = getPackageVersion();
console.log(`Target version: ${targetVersion}`);
console.log(`Current package version: ${currentVersion}`);

// 3. Sync package version to target
if (currentVersion !== targetVersion) {
  console.log("Syncing package version from changelog...");
  run(`npm version ${targetVersion} --no-git-tag-version`);
  console.log(`  package.json -> ${targetVersion}\n`);
} else {
  console.log("  package.json already matches target version\n");
}

// 4. Reinstall dependencies from scratch (remove lock + node_modules first)
reinstallDependenciesFromScratch();

// 5. Stage + commit + tag
console.log("Committing and tagging...");
const files = [
  "CHANGELOG.md",
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "npm-shrinkwrap.json",
].filter((p) => existsSync(p));
if (files.length) {
  run(`git add ${files.map(shellQuote).join(" ")}`);
}

const stagedQuietExit = run("git diff --cached --quiet", { ignoreError: true, silent: true });
if (stagedQuietExit === "") {
  // When command succeeds, stdout is usually empty string.
  console.error("Error: no staged changes to release.");
  process.exit(1);
}

run(`git commit -m "Release v${targetVersion}"`);
run(`git tag v${targetVersion}`);
console.log();

// 6. Publish
console.log("Publishing to npm...");
run("npm publish");
console.log();

// 7. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${targetVersion}`);
console.log();

console.log(`=== Released v${targetVersion} ===`);
