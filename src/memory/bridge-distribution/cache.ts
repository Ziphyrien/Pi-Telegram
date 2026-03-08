// src/memory/bridge-distribution/cache.ts — same-repo bridge/package cache preparation
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

interface LocalBridgeManifest {
  name: string;
  appVersion: string;
  bridgeVersion: string;
  bridgeProtocolVersion: number;
  entry: string;
}

export interface PreparedBridgeCache {
  ok: boolean;
  cacheDir?: string;
  entryPath?: string;
  reason?: string;
}

function validateManifest(manifestPath: string, appVersion: string, expectedProtocolVersion: number): { ok: boolean; manifest?: LocalBridgeManifest; reason?: string } {
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `missing manifest: ${manifestPath}` };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as LocalBridgeManifest;
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

export function prepareSameRepoBridgeCache(options: {
  packageDir: string;
  cacheRoot: string;
  appVersion: string;
  expectedProtocolVersion: number;
  repoRef?: string;
}): PreparedBridgeCache {
  const sourceDir = resolve(options.packageDir, "packages", "pi-memory-bridge");
  const sourceManifestPath = resolve(sourceDir, "bridge.manifest.json");
  const sourceValidation = validateManifest(sourceManifestPath, options.appVersion, options.expectedProtocolVersion);
  if (!sourceValidation.ok || !sourceValidation.manifest) {
    return { ok: false, reason: sourceValidation.reason };
  }

  const repoRef = String(options.repoRef || `local-${options.appVersion}`).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const cacheDir = resolve(options.cacheRoot, `Pi-Telegram@${repoRef}`, "packages", "pi-memory-bridge", `p${options.expectedProtocolVersion}`);
  mkdirSync(resolve(cacheDir, ".."), { recursive: true });

  rmSync(cacheDir, { recursive: true, force: true });
  cpSync(sourceDir, cacheDir, { recursive: true, force: true });

  const cachedManifestPath = resolve(cacheDir, "bridge.manifest.json");
  const cachedValidation = validateManifest(cachedManifestPath, options.appVersion, options.expectedProtocolVersion);
  if (!cachedValidation.ok || !cachedValidation.manifest) {
    rmSync(cacheDir, { recursive: true, force: true });
    return { ok: false, reason: cachedValidation.reason };
  }

  const entryPath = resolve(cacheDir, cachedValidation.manifest.entry);
  if (!existsSync(entryPath)) {
    rmSync(cacheDir, { recursive: true, force: true });
    return { ok: false, reason: `missing bridge entry: ${entryPath}` };
  }

  return {
    ok: true,
    cacheDir,
    entryPath,
  };
}
