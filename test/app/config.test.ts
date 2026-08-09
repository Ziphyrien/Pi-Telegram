import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultSettingsTemplate,
  getDefaultCronConfig,
  normalizeCronConfig,
  normalizeStreamByChat,
} from "../../src/app/config.js";

// @covers app/config.ts

describe("app config", () => {
  test("creates a default settings template with app version and cron defaults", () => {
    const template = createDefaultSettingsTemplate("1.2.3");
    const cronDefaults = getDefaultCronConfig();

    assert.equal(template.lastChangelogVersion, "1.2.3");
    assert.equal(template.idleTimeoutMs, 600000);
    assert.equal(template.maxResponseLength, 4000);
    assert.deepEqual(template.bots, [
      {
        token: "<YOUR_TELEGRAM_BOT_TOKEN>",
        name: "Pi-Telegram",
        allowedUsers: [],
        cwd: template.bots[0].cwd,
        streamByChat: {},
      },
    ]);
    assert.deepEqual(template.cron, cronDefaults);
  });

  test("normalizes missing and invalid cron values to safe defaults", () => {
    const result = normalizeCronConfig({
      enabled: "yes" as unknown as boolean,
      defaultTimezone: "   ",
      maxJobsPerChat: 0,
      maxRunSeconds: 9,
      maxLatenessMs: -1,
      retryMax: -1,
      retryBackoffMs: 999,
    });
    const defaults = getDefaultCronConfig();

    assert.equal(result.changed, true);
    assert.deepEqual(result.value, defaults);
  });

  test("floors numeric cron values while preserving valid booleans and timezone", () => {
    const result = normalizeCronConfig({
      enabled: false,
      defaultTimezone: "Asia/Shanghai",
      maxJobsPerChat: 3.9,
      maxRunSeconds: 10.8,
      maxLatenessMs: 1.9,
      retryMax: 2.7,
      retryBackoffMs: 1500.9,
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.value, {
      enabled: false,
      defaultTimezone: "Asia/Shanghai",
      maxJobsPerChat: 3,
      maxRunSeconds: 10,
      maxLatenessMs: 1,
      retryMax: 2,
      retryBackoffMs: 1500,
    });
  });

  test("normalizes stream settings by chat id and boolean-like values", () => {
    const result = normalizeStreamByChat({
      "123": true,
      "00124": "false",
      "125": 1,
      bad: true,
      "126": "maybe",
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.value, {
      "123": true,
      "124": false,
      "125": true,
    });
  });

  test("rejects non-object stream settings", () => {
    assert.deepEqual(normalizeStreamByChat(undefined), { value: {}, changed: true });
    assert.deepEqual(normalizeStreamByChat([]), { value: {}, changed: true });
    assert.deepEqual(normalizeStreamByChat(null), { value: {}, changed: true });
  });

  test("leaves already-normal cron config unchanged", () => {
    const cron = getDefaultCronConfig();
    const result = normalizeCronConfig(cron);

    assert.equal(result.changed, false);
    assert.deepEqual(result.value, cron);
  });

  test("leaves normalized stream settings unchanged", () => {
    assert.deepEqual(normalizeStreamByChat({ "1": true, "-2": false }), {
      value: { "1": true, "-2": false },
      changed: false,
    });
  });

});
