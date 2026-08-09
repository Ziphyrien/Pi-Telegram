import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { synchronizeVersionLinks } from "./sync-dependency-versions.mjs";

async function createFixture(t, { basePackage, headPackage, config }) {
  const root = await mkdtemp(join(tmpdir(), "dependency-version-sync-"));
  const baseRoot = join(root, "base");
  const headRoot = join(root, "head");
  const configPath = join(root, "config.json");
  await Promise.all([
    mkdir(baseRoot, { recursive: true }),
    mkdir(headRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(baseRoot, "package.json"), `${JSON.stringify(basePackage, null, 2)}\n`),
    writeFile(join(headRoot, "package.json"), `${JSON.stringify(headPackage, null, 2)}\n`),
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { baseRoot, headRoot, configPath };
}

const vitePlusLink = {
  version: 1,
  links: [
    {
      manifest: "package.json",
      source: "/devDependencies/vite-plus",
      targets: [
        {
          path: "/overrides/vite",
          template: "npm:@voidzero-dev/vite-plus-core@{{version}}",
        },
      ],
    },
  ],
};

test("synchronizes an alias override when its source dependency changes", async (t) => {
  const fixture = await createFixture(t, {
    basePackage: {
      devDependencies: { "vite-plus": "0.2.6" },
      overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.2.6" },
    },
    headPackage: {
      devDependencies: { "vite-plus": "0.2.7" },
      overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.2.6" },
    },
    config: vitePlusLink,
  });

  const result = await synchronizeVersionLinks({ ...fixture, write: true });
  const updated = JSON.parse(await readFile(join(fixture.headRoot, "package.json"), "utf8"));

  assert.deepEqual(result.changedFiles, ["package.json"]);
  assert.equal(updated.overrides.vite, "npm:@voidzero-dev/vite-plus-core@0.2.7");
});

test("supports scoped JSON Pointers, full specs, and multiple targets", async (t) => {
  const config = {
    version: 1,
    links: [
      {
        manifest: "package.json",
        source: "/dependencies/@scope~1tool",
        targets: [
          { path: "/overrides/@scope~1tool", template: "{{spec}}" },
          { path: "/pnpm/overrides/helper", template: "npm:@scope/helper@{{version}}" },
        ],
      },
    ],
  };
  const fixture = await createFixture(t, {
    basePackage: {
      dependencies: { "@scope/tool": "^1.2.3" },
      overrides: { "@scope/tool": "^1.2.3" },
      pnpm: { overrides: { helper: "npm:@scope/helper@1.2.3" } },
    },
    headPackage: {
      dependencies: { "@scope/tool": "^1.3.0" },
      overrides: { "@scope/tool": "^1.2.3" },
      pnpm: { overrides: { helper: "npm:@scope/helper@1.2.3" } },
    },
    config,
  });

  await synchronizeVersionLinks({ ...fixture, write: true });
  const updated = JSON.parse(await readFile(join(fixture.headRoot, "package.json"), "utf8"));

  assert.equal(updated.overrides["@scope/tool"], "^1.3.0");
  assert.equal(updated.pnpm.overrides.helper, "npm:@scope/helper@1.3.0");
});

test("pull-request mode ignores links whose source did not change", async (t) => {
  const packageJson = {
    devDependencies: { "vite-plus": "0.2.7" },
    overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.2.6" },
  };
  const fixture = await createFixture(t, {
    basePackage: packageJson,
    headPackage: packageJson,
    config: vitePlusLink,
  });

  const result = await synchronizeVersionLinks({ ...fixture, write: true });
  assert.deepEqual(result.changes, []);
});

test("check mode reports drift without writing", async (t) => {
  const fixture = await createFixture(t, {
    basePackage: {},
    headPackage: {
      devDependencies: { "vite-plus": "0.2.7" },
      overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.2.6" },
    },
    config: vitePlusLink,
  });
  const before = await readFile(join(fixture.headRoot, "package.json"), "utf8");

  const result = await synchronizeVersionLinks({
    configPath: fixture.configPath,
    headRoot: fixture.headRoot,
    write: false,
  });

  assert.equal(result.changes.length, 1);
  assert.equal(await readFile(join(fixture.headRoot, "package.json"), "utf8"), before);
});

test("rejects an ambiguous source when a target requests one version", async (t) => {
  const fixture = await createFixture(t, {
    basePackage: {},
    headPackage: {
      devDependencies: { "vite-plus": ">=0.2.6 <0.3.0" },
      overrides: { vite: "npm:@voidzero-dev/vite-plus-core@0.2.6" },
    },
    config: vitePlusLink,
  });

  await assert.rejects(
    synchronizeVersionLinks({
      configPath: fixture.configPath,
      headRoot: fixture.headRoot,
      write: false,
    }),
    /requires exactly one semantic version/,
  );
});
