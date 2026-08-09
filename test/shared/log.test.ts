import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { formatLogLine, highlightLogMessage, log, type LogTheme } from "../../src/shared/log.js";

// @covers shared/log.ts

const testTheme: LogTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};

describe("shared logger", () => {
  test("highlights strings, numbers, booleans, lifecycle words, and chat ids", () => {
    const highlighted = highlightLogMessage('"bot" spawned botabc123_chat42 cost=1.25 true', testTheme);

    assert.match(highlighted, /<accent>"bot"<\/accent>/);
    assert.match(highlighted, /<success>spawned<\/success>/);
    assert.match(highlighted, /<border>botabc123_chat42<\/border>/);
    assert.match(highlighted, /<warning>1\.25<\/warning>/);
    assert.match(highlighted, /<borderAccent>true<\/borderAccent>/);
  });

  test("does not re-highlight inside earlier highlighted spans", () => {
    const highlighted = highlightLogMessage('"error 123" failed 123', testTheme);

    assert.match(highlighted, /<accent>"error 123"<\/accent>/);
    assert.match(highlighted, /<error>failed<\/error>/);
    assert.match(highlighted, /<warning>123<\/warning>$/);
  });

  test("formats a full log line with timestamp, colored bold tag, and highlighted message", () => {
    const line = formatLogLine("[boot]", "running 2 bot(s)", "success", testTheme, "12:00:00");

    assert.equal(
      line,
      "12:00:00 <bold><success>[boot]</success></bold> <success>running</success> <warning>2</warning> bot<dim>(s)</dim>",
    );
  });

  test("routes logger methods to expected console methods", () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const logged: string[] = [];
    const warned: string[] = [];
    const errored: string[] = [];

    console.log = (msg?: unknown) => { logged.push(String(msg)); };
    console.warn = (msg?: unknown) => { warned.push(String(msg)); };
    console.error = (msg?: unknown) => { errored.push(String(msg)); };

    try {
      log.boot("started");
      log.pool("spawned");
      log.bot(2, "running");
      log.shutdown("stopping");
      log.warn("careful");
      log.error("boot", "failed");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    assert.equal(logged.length, 4);
    assert.equal(warned.length, 1);
    assert.equal(errored.length, 1);
    assert.match(logged[0], /\[boot\]/);
    assert.match(logged[1], /\[pool\]/);
    assert.match(logged[2], /\[bot2\]/);
    assert.match(logged[3], /\[shutdown\]/);
    assert.match(warned[0], /\[warn\]/);
    assert.match(errored[0], /\[boot\]/);
  });
});
