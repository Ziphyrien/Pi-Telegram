#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const supportedPlaceholders = new Set(["spec", "version"]);
const placeholderPattern = /{{\s*([^{}]+?)\s*}}/g;
const semanticVersionPattern =
  /(?:^|[^0-9A-Za-z])(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z])/g;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodePointer(pointer, label) {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error(`${label} must be a JSON Pointer starting with "/"`);
  }

  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function getPointer(document, pointer, label) {
  let value = document;

  for (const part of decodePointer(pointer, label)) {
    if (!isRecord(value) && !Array.isArray(value)) {
      throw new Error(`${label} does not resolve to an existing value`);
    }
    if (!Object.hasOwn(value, part)) {
      throw new Error(`${label} does not resolve to an existing value`);
    }
    value = value[part];
  }

  return value;
}

function setPointer(document, pointer, value, label) {
  const parts = decodePointer(pointer, label);
  if (parts.length === 0) {
    throw new Error(`${label} cannot replace the manifest root`);
  }

  const key = parts.pop();
  let parent = document;
  for (const part of parts) {
    if (!isRecord(parent) && !Array.isArray(parent)) {
      throw new Error(`${label} does not resolve to an existing value`);
    }
    if (!Object.hasOwn(parent, part)) {
      throw new Error(`${label} does not resolve to an existing value`);
    }
    parent = parent[part];
  }

  if ((!isRecord(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, key)) {
    throw new Error(`${label} does not resolve to an existing value`);
  }
  parent[key] = value;
}

function resolveInside(root, path, label) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new Error(`${label} must be a non-empty path relative to the repository root`);
  }

  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the repository root`);
  }

  return absolutePath;
}

function extractSemanticVersions(spec) {
  return [...spec.matchAll(semanticVersionPattern)].map((match) => match[1]);
}

function renderTemplate(template, spec, label) {
  if (typeof template !== "string" || template.length === 0) {
    throw new Error(`${label}.template must be a non-empty string`);
  }

  const placeholders = [...template.matchAll(placeholderPattern)].map((match) => match[1]);
  for (const placeholder of placeholders) {
    if (!supportedPlaceholders.has(placeholder)) {
      throw new Error(`${label}.template uses unsupported placeholder {{${placeholder}}}`);
    }
  }

  let version;
  if (placeholders.includes("version")) {
    const versions = extractSemanticVersions(spec);
    if (versions.length !== 1) {
      throw new Error(
        `${label} requires exactly one semantic version in source spec ${JSON.stringify(spec)}`,
      );
    }
    version = versions[0];
  }

  return template.replace(placeholderPattern, (_match, placeholder) =>
    placeholder === "spec" ? spec : version ?? "",
  );
}

function validateConfig(config) {
  if (!isRecord(config) || config.version !== 1 || !Array.isArray(config.links)) {
    throw new Error("config must contain version 1 and a links array");
  }

  const targetPaths = new Set();
  for (const [linkIndex, link] of config.links.entries()) {
    const label = `links[${linkIndex}]`;
    if (!isRecord(link) || typeof link.manifest !== "string" || typeof link.source !== "string") {
      throw new Error(`${label} must define manifest and source strings`);
    }
    if (!Array.isArray(link.targets) || link.targets.length === 0) {
      throw new Error(`${label}.targets must be a non-empty array`);
    }
    for (const [targetIndex, target] of link.targets.entries()) {
      if (!isRecord(target) || typeof target.path !== "string" || typeof target.template !== "string") {
        throw new Error(`${label}.targets[${targetIndex}] must define path and template strings`);
      }
      const targetKey = `${link.manifest}\u0000${target.path}`;
      if (targetPaths.has(targetKey)) {
        throw new Error(`${label}.targets[${targetIndex}] duplicates target ${target.path}`);
      }
      targetPaths.add(targetKey);
    }
  }

  return config;
}

function serializationStyle(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const indentationMatch = text.match(/\r?\n([\t ]+)"/);
  const indentation = indentationMatch?.[1] ?? "  ";
  return { newline, indentation };
}

async function readJson(path, label) {
  const text = await readFile(path, "utf8");
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${reason}`);
  }
  return { document, text };
}

export async function synchronizeVersionLinks({
  configPath,
  headRoot,
  baseRoot,
  write = true,
}) {
  const { document: rawConfig } = await readJson(resolve(configPath), "sync config");
  const config = validateConfig(rawConfig);
  const manifests = new Map();
  const changes = [];

  async function loadManifest(manifestPath) {
    if (manifests.has(manifestPath)) return manifests.get(manifestPath);

    const headPath = resolveInside(headRoot, manifestPath, "manifest");
    const head = await readJson(headPath, `head ${manifestPath}`);
    const base = baseRoot
      ? await readJson(resolveInside(baseRoot, manifestPath, "manifest"), `base ${manifestPath}`)
      : undefined;
    const loaded = { headPath, head, base, changed: false };
    manifests.set(manifestPath, loaded);
    return loaded;
  }

  for (const [linkIndex, link] of config.links.entries()) {
    const loaded = await loadManifest(link.manifest);
    const sourceLabel = `links[${linkIndex}].source`;
    const nextSource = getPointer(loaded.head.document, link.source, sourceLabel);
    if (typeof nextSource !== "string") {
      throw new Error(`${sourceLabel} must resolve to a string`);
    }

    if (loaded.base) {
      const previousSource = getPointer(loaded.base.document, link.source, sourceLabel);
      if (previousSource === nextSource) continue;
    }

    for (const [targetIndex, target] of link.targets.entries()) {
      const targetLabel = `links[${linkIndex}].targets[${targetIndex}]`;
      const current = getPointer(loaded.head.document, target.path, `${targetLabel}.path`);
      if (typeof current !== "string") {
        throw new Error(`${targetLabel}.path must resolve to a string`);
      }

      const expected = renderTemplate(target.template, nextSource, targetLabel);
      if (current === expected) continue;

      setPointer(loaded.head.document, target.path, expected, `${targetLabel}.path`);
      loaded.changed = true;
      changes.push({
        manifest: link.manifest,
        source: link.source,
        target: target.path,
        previous: current,
        next: expected,
      });
    }
  }

  const changedFiles = [];
  for (const [manifestPath, loaded] of manifests) {
    if (!loaded.changed) continue;
    changedFiles.push(manifestPath);
    if (!write) continue;

    const { newline, indentation } = serializationStyle(loaded.head.text);
    const serialized = `${JSON.stringify(loaded.head.document, null, indentation)}\n`.replaceAll(
      "\n",
      newline,
    );
    await writeFile(loaded.headPath, serialized, "utf8");
  }

  return { changedFiles, changes };
}

function parseArguments(argv) {
  const options = {
    configPath: ".github/dependency-version-sync.json",
    headRoot: process.cwd(),
    baseRoot: undefined,
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--config") options.configPath = value;
    else if (argument === "--head-root") options.headRoot = value;
    else if (argument === "--base-root") options.baseRoot = value;
    else throw new Error(`unknown argument ${argument}`);
    index += 1;
  }

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await synchronizeVersionLinks({
    configPath: options.configPath,
    headRoot: options.headRoot,
    baseRoot: options.baseRoot,
    write: !options.check,
  });

  for (const change of result.changes) {
    console.log(
      `${change.manifest}${change.target}: ${JSON.stringify(change.previous)} -> ${JSON.stringify(change.next)}`,
    );
  }

  if (options.check && result.changes.length > 0) {
    throw new Error(
      "linked dependency versions are out of sync; run node .github/scripts/sync-dependency-versions.mjs",
    );
  }

  if (result.changes.length === 0) console.log("Linked dependency versions are in sync.");
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
