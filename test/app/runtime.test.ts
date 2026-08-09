import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { describeRunnerError, formatErr, getTelegramErrorCode } from "../../src/app/runtime.js";

// @covers app/runtime.ts

describe("app runtime helpers", () => {
  test("formats unknown errors consistently", () => {
    assert.equal(formatErr(new Error("boom")), "boom");
    assert.equal(formatErr("plain"), "plain");
    assert.equal(formatErr(123), "123");
  });

  test("extracts Telegram error codes only when numeric", () => {
    assert.equal(getTelegramErrorCode({ error_code: 409 }), 409);
    assert.equal(getTelegramErrorCode({ error_code: "409" }), undefined);
    assert.equal(getTelegramErrorCode(null), undefined);
    assert.equal(getTelegramErrorCode("error"), undefined);
  });

  test("describes runner errors with Telegram metadata and retry parameters", () => {
    const description = describeRunnerError({
      message: "Conflict",
      error_code: 409,
      description: "terminated by other getUpdates request",
      parameters: { retry_after: 15 },
    });

    assert.equal(
      description,
      "[object Object] | error_code=409 | description=terminated by other getUpdates request | retry_after=15s",
    );
  });

  test("describes Error instances without object metadata", () => {
    assert.equal(describeRunnerError(new Error("network down")), "network down");
  });

  test("ignores blank descriptions and nonnumeric retry_after parameters", () => {
    const description = describeRunnerError({
      error_code: 500,
      description: "   ",
      parameters: { retry_after: "15" },
    });

    assert.equal(description, "[object Object] | error_code=500");
  });

  test("describes null and custom stringified runner errors", () => {
    assert.equal(describeRunnerError(null), "null");
    assert.equal(describeRunnerError({ toString: () => "custom runner failure" }), "custom runner failure");
  });

  test("extracts Telegram code from Error objects with attached numeric metadata", () => {
    const err = new Error("unauthorized") as Error & { error_code?: number };
    err.error_code = 401;

    assert.equal(getTelegramErrorCode(err), 401);
    assert.equal(describeRunnerError(err), "unauthorized | error_code=401");
  });
});
