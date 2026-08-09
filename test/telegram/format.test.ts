import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mdToPlainText, mdToTgHtml } from "../../src/telegram/format.js";

// @covers telegram/format.ts

describe("telegram formatting", () => {
  test("renders markdown into Telegram-supported HTML", () => {
    const html = mdToTgHtml("# Title\n\n**bold** and _italic_\n\n- item");

    assert.match(html, /^<b>Title<\/b>/);
    assert.match(html, /<b>bold<\/b> and <i>italic<\/i>/);
    assert.match(html, /• item/);
    assert.doesNotMatch(html, /<p>|<ul>|<li>|<h1>/);
  });

  test("sanitizes unsupported HTML and unsafe links", () => {
    const html = mdToTgHtml('<script>alert(1)</script><a href="javascript:alert(1)">bad</a> <a href="https://example.test">ok</a>');

    assert.doesNotMatch(html, /script|javascript:/i);
    assert.match(html, /<a href="https:\/\/example\.test">ok<\/a>/);
  });

  test("allows simple raw Telegram tags but still normalizes empty output", () => {
    assert.equal(mdToTgHtml("<b>safe</b>"), "<b>safe</b>");
    assert.equal(mdToTgHtml(""), "(无回复)");
  });

  test("converts markdown and HTML to plain text", () => {
    const plain = mdToPlainText("**bold**<br><script>bad</script>\n\ntext&nbsp;here");

    assert.doesNotMatch(plain, /<|>|script/);
    assert.match(plain, /bold/);
    assert.match(plain, /text here/);
  });

  test("returns fallback plain text for empty content", () => {
    assert.equal(mdToPlainText(""), "(无回复)");
  });

  test("allows Telegram tg links and rejects protocol-relative links", () => {
    const html = mdToTgHtml("[mention](tg://user?id=123) [bad](//example.test/path)");

    assert.match(html, /<a href="tg:\/\/user\?id=123">mention<\/a>/);
    assert.doesNotMatch(html, /href="\/\//);
  });

  test("normalizes supported Telegram HTML aliases and spoiler spans", () => {
    const html = mdToTgHtml('<strong>bold</strong> <span class="tg-spoiler">secret</span> <span>plain</span>');

    assert.match(html, /<b>bold<\/b>/);
    assert.match(html, /<tg-spoiler>secret<\/tg-spoiler>/);
    assert.doesNotMatch(html, /<span>/);
    assert.match(html, /plain/);
  });

  test("strips unsafe attributes while preserving safe Telegram tags", () => {
    const html = mdToTgHtml('<b onclick="bad">bold</b> <a href="https://example.test" onclick="bad">link</a>');

    assert.equal(html, '<b>bold</b> <a href="https://example.test">link</a>');
  });

  test("keeps Telegram emoji and expandable blockquote attributes", () => {
    const html = mdToTgHtml('<tg-emoji emoji-id="12345">🙂</tg-emoji> <blockquote expandable="true">Quote</blockquote>');

    assert.match(html, /<tg-emoji emoji-id="12345">🙂<\/tg-emoji>/);
    assert.match(html, /<blockquote expandable="true">Quote<\/blockquote>/);
  });

  test("rejects unsupported markdown link schemes without dropping text", () => {
    const html = mdToTgHtml("[mail](mailto:a@example.test) [http](http://example.test)");

    assert.match(html, /\[mail\]\(mailto:a@example\.test\)/);
    assert.match(html, /<a href="http:\/\/example\.test">http<\/a>/);
    assert.doesNotMatch(html, /<a href="mailto:/i);
  });

  test("collapses excessive blank lines in HTML and plain text outputs", () => {
    assert.equal(mdToTgHtml("line1\n\n\n\nline2"), "line1\n\nline2");
    assert.equal(mdToPlainText("line1\n\n\n\nline2"), "line1\n\nline2");
  });
});
