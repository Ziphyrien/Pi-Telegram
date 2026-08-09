import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { main } from "../src/main.js";

// @covers main.ts

describe("main entrypoint", () => {
  test("exports a main function without auto-starting runApp during import", () => {
    assert.equal(typeof main, "function");
  });

  test("delegates to the supplied runner and intentionally does not await it", async () => {
    let called = 0;
    let resolveRun!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    main(async () => {
      called += 1;
      await finished;
    });

    assert.equal(called, 1);
    resolveRun();
    await finished;
  });
});
