// src/version.ts — package/version/update/changelog helpers
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type InstallMethod = "pnpm" | "yarn" | "bun" | "npm" | "unknown";

export interface PackageMeta {
  name: string;
  version: string;
}

export interface ChangelogEntry {
  major: number;
  minor: number;
  patch: number;
  content: string;
}

export const isBunBinary = import.meta.url.includes("$bunfs")
  || import.meta.url.includes("~BUN")
  || import.meta.url.includes("%7EBUN");

const isBunRuntime = !!(process as any)?.versions?.bun;

export function detectInstallMethod(): InstallMethod {

  const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

  if (
    resolvedPath.includes("/pnpm/global/")
    || resolvedPath.includes("/.pnpm/")
    || resolvedPath.includes("\\pnpm\\")
  ) {
    return "pnpm";
  }

  if (
    resolvedPath.includes("/yarn/")
    || resolvedPath.includes("/.yarn/")
    || resolvedPath.includes("\\yarn\\")
  ) {
    return "yarn";
  }

  if (isBunRuntime) return "bun";

  if (
    resolvedPath.includes("/npm/")
    || resolvedPath.includes("/node_modules/")
    || resolvedPath.includes("\\npm\\")
  ) {
    return "npm";
  }

  return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
  const method = detectInstallMethod();
  switch (method) {
    case "pnpm":
      return `Run: pnpm install -g ${packageName}`;
    case "yarn":
      return `Run: yarn global add ${packageName}`;
    case "bun":
      return `Run: bun install -g ${packageName}`;
    case "npm":
      return `Run: npm install -g ${packageName}`;
    default:
      return `Run: npm install -g ${packageName}`;
  }
}

/**
 * Get package base directory (contains package.json / CHANGELOG.md).
 */
export function getPackageDir(): string {
  const envDir = process.env.PITG_PACKAGE_DIR || process.env.PI_PACKAGE_DIR;
  if (envDir) {
    if (envDir === "~") return homedir();
    if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
    return envDir;
  }

  if (isBunBinary) {
    return dirname(process.execPath);
  }

  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }

  return __dirname;
}

export function getPackageJsonPath(): string {
  return join(getPackageDir(), "package.json");
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
  return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

export function getPackageMeta(): PackageMeta {
  try {
    const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as {
      name?: string;
      version?: string;
    };

    return {
      name: pkg.name || "@ziphyrien/pi-telegram",
      version: pkg.version || "0.0.0",
    };
  } catch {
    return {
      name: "@ziphyrien/pi-telegram",
      version: "0.0.0",
    };
  }
}

function parseVersion(v: string): [number, number, number] {
  const m = v.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10)];
}

export function compareVersions(v1: string, v2: string): number {
  const [aMaj, aMin, aPatch] = parseVersion(v1);
  const [bMaj, bMin, bPatch] = parseVersion(v2);

  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

function isLikelyGlobalInstall(packageDir: string): boolean {
  const p = packageDir.toLowerCase();

  const markers = [
    "/pnpm/global/",
    "\\pnpm\\global\\",
    "/lib/node_modules/",
    "\\lib\\node_modules\\",
    "/roaming/npm/node_modules/",
    "\\roaming\\npm\\node_modules\\",
    "/yarn/global/",
    "\\yarn\\global\\",
  ];

  return markers.some((m) => p.includes(m));
}

export function shouldCheckUpdatesOnStartup(): boolean {
  const method = detectInstallMethod();
  if (method === "unknown") return false;
  return isLikelyGlobalInstall(getPackageDir());
}

export async function checkLatestVersion(packageName: string, currentVersion: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as { version?: string };
    const latestVersion = (data.version || "").trim();
    if (!latestVersion) return undefined;

    if (compareVersions(latestVersion, currentVersion) > 0) {
      return latestVersion;
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
  if (!existsSync(changelogPath)) {
    return [];
  }

  try {
    const content = readFileSync(changelogPath, "utf-8");
    const lines = content.split("\n");
    const entries: ChangelogEntry[] = [];

    let currentLines: string[] = [];
    let currentVersion: Omit<ChangelogEntry, "content"> | null = null;

    for (const line of lines) {
      if (line.startsWith("## ")) {
        if (currentVersion && currentLines.length > 0) {
          entries.push({
            ...currentVersion,
            content: currentLines.join("\n").trim(),
          });
        }

        const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
        if (versionMatch) {
          currentVersion = {
            major: Number.parseInt(versionMatch[1], 10),
            minor: Number.parseInt(versionMatch[2], 10),
            patch: Number.parseInt(versionMatch[3], 10),
          };
          currentLines = [line];
        } else {
          currentVersion = null;
          currentLines = [];
        }
      } else if (currentVersion) {
        currentLines.push(line);
      }
    }

    if (currentVersion && currentLines.length > 0) {
      entries.push({
        ...currentVersion,
        content: currentLines.join("\n").trim(),
      });
    }

    return entries;
  } catch {
    return [];
  }
}

function compareChangelogEntry(a: ChangelogEntry, b: ChangelogEntry): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
  const [major, minor, patch] = parseVersion(lastVersion);
  const last: ChangelogEntry = { major, minor, patch, content: "" };
  return entries.filter((entry) => compareChangelogEntry(entry, last) > 0);
}

export function getNewChangelogText(lastVersion?: string): string | undefined {
  if (!lastVersion) return undefined;
  const entries = parseChangelog(getChangelogPath());
  const newEntries = getNewEntries(entries, lastVersion);
  if (!newEntries.length) return undefined;
  return newEntries.map((e) => e.content).join("\n\n");
}
