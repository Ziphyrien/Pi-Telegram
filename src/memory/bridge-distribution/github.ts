// src/memory/bridge-distribution/github.ts — fetch same-repo bridge package from GitHub raw refs
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface BridgeManifest {
  name: string;
  appVersion: string;
  bridgeVersion: string;
  bridgeProtocolVersion: number;
  entry: string;
}

export interface GitHubBridgeFetchResult {
  ok: boolean;
  cacheDir?: string;
  entryPath?: string;
  reason?: string;
  ref?: string;
}

function normalizeRepo(repo: string): string {
  return repo
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^github\.com\//i, "")
    .replace(/^\//, "")
    .trim();
}

function buildRawUrl(repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path.replace(/^\/+/, "")}`;
}

async function fetchText(url: string, timeoutMs = 4000): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function validateManifest(manifestPath: string, appVersion: string, expectedProtocolVersion: number): { ok: boolean; manifest?: BridgeManifest; reason?: string } {
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `missing manifest: ${manifestPath}` };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as BridgeManifest;
    if (manifest.appVersion !== appVersion) {
      return { ok: false, reason: `bridge appVersion mismatch (${manifest.appVersion} != ${appVersion})` };
    }
    if (manifest.bridgeVersion !== appVersion) {
      return { ok: false, reason: `bridge bridgeVersion mismatch (${manifest.bridgeVersion} != ${appVersion})` };
    }
    if (manifest.bridgeProtocolVersion !== expectedProtocolVersion) {
      return { ok: false, reason: `bridge protocol mismatch (${manifest.bridgeProtocolVersion} != ${expectedProtocolVersion})` };
    }
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchSameRepoBridgeFromGitHub(options: {
  repo: string;
  refs: string[];
  cacheRoot: string;
  appVersion: string;
  expectedProtocolVersion: number;
}): Promise<GitHubBridgeFetchResult> {
  const repo = normalizeRepo(options.repo);
  if (!repo || !repo.includes("/")) {
    return { ok: false, reason: `invalid repo: ${options.repo}` };
  }

  const files = [
    "packages/pi-memory-bridge/package.json",
    "packages/pi-memory-bridge/README.md",
    "packages/pi-memory-bridge/bridge.manifest.json",
    "packages/pi-memory-bridge/extensions/memory-bridge.ts",
  ];

  for (const ref of options.refs.filter(Boolean)) {
    const safeRef = ref.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const cacheDir = resolve(options.cacheRoot, `${repo.replace(/[\\/]+/g, "_")}@${safeRef}`, "packages", "pi-memory-bridge", `p${options.expectedProtocolVersion}`);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(resolve(cacheDir, "extensions"), { recursive: true });

    let allOk = true;
    for (const relativePath of files) {
      const text = await fetchText(buildRawUrl(repo, ref, relativePath));
      if (typeof text !== "string") {
        allOk = false;
        break;
      }
      const targetPath = resolve(cacheDir, relativePath.replace(/^packages\/pi-memory-bridge\//, ""));
      mkdirSync(resolve(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, text, "utf-8");
    }

    if (!allOk) {
      rmSync(cacheDir, { recursive: true, force: true });
      continue;
    }

    const manifestPath = resolve(cacheDir, "bridge.manifest.json");
    const validation = validateManifest(manifestPath, options.appVersion, options.expectedProtocolVersion);
    if (!validation.ok || !validation.manifest) {
      rmSync(cacheDir, { recursive: true, force: true });
      continue;
    }

    const entryPath = resolve(cacheDir, validation.manifest.entry);
    if (!existsSync(entryPath)) {
      rmSync(cacheDir, { recursive: true, force: true });
      continue;
    }

    return {
      ok: true,
      cacheDir,
      entryPath,
      ref,
    };
  }

  return {
    ok: false,
    reason: `failed to fetch bridge from GitHub repo=${repo} refs=${options.refs.join(",")}`,
  };
}
