#!/usr/bin/env node
/**
 * Release script for pi-telegram
 *
 * Usage: node scripts/release.mjs <major|minor|patch>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump version via npm version <type> --no-git-tag-version
 * 3. Update CHANGELOG.md files: keep [Unreleased], insert [version] - date below it
 * 4. Commit and tag
 * 5. Publish to npm
 * 6. Push to remote
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";

const BUMP_TYPE = process.argv[2];

if (!["major", "minor", "patch"].includes(BUMP_TYPE)) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch>");
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

function getVersion() {
	const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
	return pkg.version;
}

function getChangelogPath() {
	const changelog = "CHANGELOG.md";
	if (!existsSync(changelog)) {
		console.error("Error: CHANGELOG.md not found in project root.");
		process.exit(1);
	}
	return changelog;
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelog = getChangelogPath();
	const content = readFileSync(changelog, "utf-8");

	if (!content.includes("## [Unreleased]")) {
		console.error(`Error: ${changelog} has no [Unreleased] section`);
		process.exit(1);
	}

	const updated = content.replace(
		"## [Unreleased]",
		`## [Unreleased]\n\n## [${version}] - ${date}`
	);
	writeFileSync(changelog, updated);
	console.log(`  Updated ${changelog}`);
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Bump version
console.log(`Bumping version (${BUMP_TYPE})...`);
run(`npm version ${BUMP_TYPE} --no-git-tag-version`);
const version = getVersion();
console.log(`  New version: ${version}\n`);

// 3. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 4. Commit and tag
console.log("Committing and tagging...");
run("git add .");
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 5. Publish
console.log("Publishing to npm...");
run("npm publish");
console.log();

// 6. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
