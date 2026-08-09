import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTgReplyDirective,
  rememberReplyMessage,
  resolveReplyParameters,
} from "../../src/telegram/reply.js";

// @covers telegram/reply.ts

describe("tg-reply directives", () => {
  test("extracts one reply directive and warns about extras", () => {
    const result = extractTgReplyDirective([
      "before",
      '<tg-reply from="user" contains="needle" quote="need" />',
      "middle",
      '<tg-reply message_id="2" />',
      "after",
    ].join("\n"));

    assert.equal(result.text, "before\n\nmiddle\n\nafter");
    assert.deepEqual(result.directive, {
      role: "user",
      contains: "needle",
      quote: "need",
    });
    assert.deepEqual(result.warnings, ["检测到多个 tg-reply 标签，仅使用第一个"]);
  });

  test("uses tag body as quote and normalizes role aliases", () => {
    const result = extractTgReplyDirective('<tg-reply who="assistant" contains="answer"> quoted text </tg-reply>');

    assert.deepEqual(result.directive, {
      role: "self",
      contains: "answer",
      quote: "quoted text",
    });
  });

  test("resolves reply parameters by message id and quote position", () => {
    const scope = `reply-test-${Date.now()}-by-id`;
    rememberReplyMessage(scope, "user", 10, "hello quoted target");
    rememberReplyMessage(scope, "self", 11, "assistant message");

    const result = resolveReplyParameters(scope, {
      role: "any",
      messageId: 10,
      quote: "quoted",
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.replyParameters, {
      message_id: 10,
      allow_sending_without_reply: true,
      quote: "quoted",
      quote_position: 6,
    });
  });

  test("resolves latest matching message by role and contains", () => {
    const scope = `reply-test-${Date.now()}-latest`;
    rememberReplyMessage(scope, "user", 20, "first needle");
    rememberReplyMessage(scope, "self", 21, "self needle");
    rememberReplyMessage(scope, "user", 22, "second needle");

    const result = resolveReplyParameters(scope, {
      role: "user",
      contains: "needle",
    });

    assert.equal(result.replyParameters?.message_id, 22);
    assert.deepEqual(result.warnings, []);
  });

  test("warns when no history or quote fragment does not match", () => {
    const empty = resolveReplyParameters(`reply-test-${Date.now()}-empty`, { role: "any", contains: "x" });
    assert.equal(empty.replyParameters, undefined);
    assert.deepEqual(empty.warnings, ["回复工具未找到可引用的历史消息"]);

    const scope = `reply-test-${Date.now()}-bad-quote`;
    rememberReplyMessage(scope, "user", 30, "known text");
    const badQuote = resolveReplyParameters(scope, { role: "user", contains: "known", quote: "missing" });
    assert.deepEqual(badQuote.replyParameters, {
      message_id: 30,
      allow_sending_without_reply: true,
    });
    assert.deepEqual(badQuote.warnings, ["回复工具未匹配到 quote 片段，已仅按消息回复"]);
  });

  test("warns and ignores tg-reply directives without target information", () => {
    const result = extractTgReplyDirective("before <tg-reply from='user' /> after");

    assert.equal(result.text, "before  after");
    assert.equal(result.directive, undefined);
    assert.deepEqual(result.warnings, ["tg-reply 缺少定位信息（message_id 或 contains/quote）"]);
  });

  test("trims remembered messages and keeps only the newest history entries", () => {
    const scope = `reply-test-${Date.now()}-history-limit`;
    rememberReplyMessage(scope, "user", 1, "   ");
    for (let i = 0; i < 305; i += 1) {
      rememberReplyMessage(scope, "user", i + 2, `message-${i}`);
    }

    const oldestEvicted = resolveReplyParameters(scope, { role: "any", messageId: 2 });
    assert.equal(oldestEvicted.replyParameters, undefined);
    assert.deepEqual(oldestEvicted.warnings, ["回复工具未匹配到目标消息，已退化为普通回复"]);

    const newest = resolveReplyParameters(scope, { role: "user", contains: "message-304" });
    assert.equal(newest.replyParameters?.message_id, 306);
  });

  test("limits reply quote payloads to Telegram's quote length bound", () => {
    const scope = `reply-test-${Date.now()}-quote-limit`;
    const longQuote = "q".repeat(1200);
    rememberReplyMessage(scope, "user", 40, `${longQuote} tail`);

    const result = resolveReplyParameters(scope, { role: "user", contains: "tail", quote: longQuote });

    assert.equal(result.replyParameters?.message_id, 40);
    assert.equal(result.replyParameters?.quote, "q".repeat(1024));
    assert.equal(result.replyParameters?.quote_position, 0);
  });

  test("parses message id and contains aliases", () => {
    const byMessageId = extractTgReplyDirective('<tg-reply to-message-id="55" match="needle" text="quote" />');
    const byFind = extractTgReplyDirective('<tg-reply author="human" find="target" />');

    assert.deepEqual(byMessageId.directive, {
      messageId: 55,
      role: "any",
      contains: "needle",
      quote: "quote",
    });
    assert.deepEqual(byFind.directive, {
      role: "user",
      contains: "target",
      quote: undefined,
    });
  });

  test("preserves CRLF text outside directives while normalizing directive bodies", () => {
    const result = extractTgReplyDirective("before\r\n\r\n\r\n<tg-reply contains='x'> quote\r\nline </tg-reply>\r\n\r\n\r\nafter");

    assert.equal(result.text, "before\r\n\r\n\r\n\r\n\r\n\r\nafter");
    assert.deepEqual(result.directive, {
      role: "any",
      contains: "x",
      quote: "quote\nline",
    });
  });

  test("message id selection takes precedence while contains becomes the quote seed", () => {
    const scope = `reply-test-${Date.now()}-id-priority`;
    rememberReplyMessage(scope, "user", 50, "does not contain requested text");
    rememberReplyMessage(scope, "user", 51, "contains requested text");

    const result = resolveReplyParameters(scope, {
      role: "user",
      messageId: 50,
      contains: "requested",
    });

    assert.equal(result.replyParameters?.message_id, 50);
    assert.equal(result.replyParameters?.quote, "requested");
    assert.equal(result.replyParameters?.quote_position, 17);
    assert.deepEqual(result.warnings, []);
  });

  test("role any resolves the latest matching self or user message", () => {
    const scope = `reply-test-${Date.now()}-any-role`;
    rememberReplyMessage(scope, "user", 60, "needle from user");
    rememberReplyMessage(scope, "self", 61, "needle from self");

    const result = resolveReplyParameters(scope, { role: "any", contains: "needle" });

    assert.equal(result.replyParameters?.message_id, 61);
    assert.deepEqual(result.warnings, []);
  });

  test("resolving without a directive is a no-op", () => {
    assert.deepEqual(resolveReplyParameters(`reply-test-${Date.now()}-none`), { warnings: [] });
  });

  test("isolates remembered reply history by scope", () => {
    const firstScope = `reply-test-${Date.now()}-scope-a`;
    const secondScope = `reply-test-${Date.now()}-scope-b`;
    rememberReplyMessage(firstScope, "user", 70, "shared needle from first scope");
    rememberReplyMessage(secondScope, "user", 71, "shared needle from second scope");

    assert.equal(resolveReplyParameters(firstScope, { role: "user", contains: "needle" }).replyParameters?.message_id, 70);
    assert.equal(resolveReplyParameters(secondScope, { role: "user", contains: "needle" }).replyParameters?.message_id, 71);
  });

  test("ignores invalid message ids and falls back to contains matching", () => {
    const parsed = extractTgReplyDirective('<tg-reply message_id="abc" contains="needle" />');
    const scope = `reply-test-${Date.now()}-invalid-id`;
    rememberReplyMessage(scope, "user", 80, "message with needle");

    assert.deepEqual(parsed.directive, { role: "any", contains: "needle", quote: undefined });
    assert.equal(resolveReplyParameters(scope, parsed.directive).replyParameters?.message_id, 80);
  });

  test("quote attribute takes precedence over tag body", () => {
    const result = extractTgReplyDirective('<tg-reply contains="needle" quote="attr quote">body quote</tg-reply>');

    assert.deepEqual(result.directive, {
      role: "any",
      contains: "needle",
      quote: "attr quote",
    });
  });

  test("role filters prevent matching messages from other authors", () => {
    const scope = `reply-test-${Date.now()}-role-filter`;
    rememberReplyMessage(scope, "self", 90, "needle only from self");

    const result = resolveReplyParameters(scope, { role: "user", contains: "needle" });

    assert.equal(result.replyParameters, undefined);
    assert.deepEqual(result.warnings, ["回复工具未匹配到目标消息，已退化为普通回复"]);
  });
});
