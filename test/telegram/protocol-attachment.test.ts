import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";
import { setLanguage } from "../../src/i18n.js";
import { extractTgAttachments } from "../../src/telegram/protocol.js";

// @covers telegram/protocol.ts

afterEach(() => setLanguage("zh"));

describe("tg-attachment directives", () => {
  test("extracts file_id attachments and infers kind from explicit type", () => {
    const result = extractTgAttachments('hello <tg-attachment as="photo" file_id="AgAC123" filename="pic.jpg" /> world');

    assert.equal(result.text, "hello  world");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "photo");
    assert.equal(result.attachments[0].media, "AgAC123");
    assert.equal(result.attachments[0].label, "pic.jpg");
  });

  test("sanitizes and deduplicates uploaded filenames", () => {
    const result = extractTgAttachments([
      '<tg-attachment filename="bad:/name.txt">one</tg-attachment>',
      '<tg-attachment filename="bad:/name.txt">two</tg-attachment>',
    ].join("\n"));

    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 2);
    assert.equal(result.attachments[0].label, "bad__name.txt");
    assert.equal(result.attachments[1].label, "bad__name (2).txt");
    assert.ok(result.attachments[0].media instanceof InputFile);
    assert.ok(result.attachments[1].media instanceof InputFile);
  });

  test("infers media kind and filename from URL path", () => {
    const result = extractTgAttachments('<tg-attachment url="https://example.test/path/movie.mp4?download=1" />');

    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "video");
    assert.equal(result.attachments[0].label, "movie.mp4");
    assert.ok(result.attachments[0].media instanceof InputFile);
  });

  test("accepts existing local files and rejects missing or non-http URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pitg-attachment-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "hello", "utf-8");

    const result = extractTgAttachments([
      `<tg-attachment path="${file.replace(/\\/g, "/")}" />`,
      '<tg-attachment url="ftp://example.test/a.txt" />',
      '<tg-attachment path="/path/that/does/not/exist.txt" />',
    ].join("\n"));

    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "document");
    assert.equal(result.attachments[0].label, "note.txt");
    assert.match(result.warnings.join("\n"), /URL 非法/);
    assert.match(result.warnings.join("\n"), /本地路径不存在/);
  });

  test("formats attachment errors in English with interpolated labels", () => {
    setLanguage("en");
    const result = extractTgAttachments('<tg-attachment url="ftp://example.test/a.txt" filename="a.txt" />');

    assert.deepEqual(result.warnings, ["Attachment a.txt has an invalid URL"]);
  });

  test("decodes base64 uploads and warns on empty payload", () => {
    const result = extractTgAttachments([
      '<tg-attachment as="document" filename="data.bin" encoding="base64">aGVsbG8=</tg-attachment>',
      '<tg-attachment as="document" filename="empty.bin" encoding="base64">   </tg-attachment>',
    ].join("\n"));

    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].label, "data.bin");
    assert.match(result.warnings.join("\n"), /empty base64 payload/);
  });

  test("uses default filenames for uploaded content and explicit kind aliases", () => {
    const result = extractTgAttachments([
      '<tg-attachment>plain text</tg-attachment>',
      '<tg-attachment as="image" encoding="base64">aGVsbG8=</tg-attachment>',
    ].join("\n"));

    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 2);
    assert.equal(result.attachments[0].kind, "document");
    assert.equal(result.attachments[0].label, "attachment-1.txt");
    assert.equal(result.attachments[1].kind, "photo");
    assert.equal(result.attachments[1].label, "attachment-2.jpg");
  });

  test("rejects local directories and very large uploads", () => {
    const dir = mkdtempSync(join(tmpdir(), "pitg-attachment-dir-"));
    const childDir = join(dir, "folder");
    mkdirSync(childDir);
    const huge = "x".repeat(45 * 1024 * 1024 + 1);

    const result = extractTgAttachments([
      `<tg-attachment path="${childDir.replace(/\\/g, "/")}" />`,
      `<tg-attachment filename="huge.txt">${huge}</tg-attachment>`,
    ].join("\n"));

    assert.equal(result.attachments.length, 0);
    assert.match(result.warnings.join("\n"), /本地路径不是文件/);
    assert.match(result.warnings.join("\n"), /超过大小限制/);
  });

  test("truncates long filenames while preserving extensions", () => {
    const stem = "a".repeat(200);
    const result = extractTgAttachments(`<tg-attachment filename="${stem}.txt">hello</tg-attachment>`);

    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].label.length, 140);
    assert.match(result.attachments[0].label, /\.txt$/);
    assert.ok(result.attachments[0].media instanceof InputFile);
  });

  test("uses default filenames for empty and dot-only names", () => {
    const result = extractTgAttachments([
      '<tg-attachment filename="   ">one</tg-attachment>',
      '<tg-attachment name="..">two</tg-attachment>',
    ].join("\n"));

    assert.deepEqual(result.attachments.map((attachment) => attachment.label), [
      "attachment-1.txt",
      "attachment-2.txt",
    ]);
  });

  test("normalizes media kind aliases and extension inference", () => {
    const result = extractTgAttachments([
      '<tg-attachment method="round-video" filename="clip.bin">round</tg-attachment>',
      '<tg-attachment type="ptt" filename="voice.bin">voice</tg-attachment>',
      '<tg-attachment filename="anim.gif">gif</tg-attachment>',
      '<tg-attachment filename="sticker.webp">sticker</tg-attachment>',
    ].join("\n"));

    assert.deepEqual(result.attachments.map((attachment) => attachment.kind), [
      "video_note",
      "voice",
      "animation",
      "sticker",
    ]);
  });

  test("decodes URL filenames and falls back to URL labels for malformed escapes", () => {
    const malformed = "https://example.test/files/%E0%A4%A";
    const result = extractTgAttachments([
      '<tg-attachment url="https://example.test/files/report%20final.pdf" />',
      `<tg-attachment url="${malformed}" />`,
    ].join("\n"));

    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 2);
    assert.equal(result.attachments[0].label, "report final.pdf");
    assert.equal(result.attachments[1].label, malformed);
  });

  test("accepts base64url content and trims edge newlines", () => {
    const result = extractTgAttachments('<tg-attachment filename="data.bin" encoding="base64">\nSGVsbG8td29ybGQ_\n</tg-attachment>');

    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].label, "data.bin");
    assert.deepEqual(result.warnings, []);
  });

  test("warns for non-empty base64 content that decodes to no bytes", () => {
    const result = extractTgAttachments('<tg-attachment filename="bad.bin" encoding="base64">%%%%</tg-attachment>');

    assert.equal(result.attachments.length, 0);
    assert.equal(result.text, "");
    assert.match(result.warnings.join("\n"), /decoded bytes is empty/);
  });

  test("accepts single-quoted hyphenated attribute aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "pitg-attachment-alias-"));
    const file = join(dir, "voice.ogg");
    writeFileSync(file, "ogg-data", "utf-8");

    const result = extractTgAttachments(`<tg-attachment file-path='${file.replace(/\\/g, "/")}' type='ptt' name='voice-note.ogg' />`);

    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "voice");
    assert.equal(result.attachments[0].label, "voice-note.ogg");
    assert.ok(result.attachments[0].media instanceof InputFile);
  });

  test("prefers file ids over other attachment sources", () => {
    const result = extractTgAttachments([
      '<tg-attachment as="video" file-id="FILE123" url="https://example.test/pic.jpg" filename="clip.mp4">ignored</tg-attachment>',
      "body",
    ].join("\n"));

    assert.deepEqual(result.warnings, []);
    assert.equal(result.text, "body");
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "video");
    assert.equal(result.attachments[0].media, "FILE123");
    assert.equal(result.attachments[0].label, "clip.mp4");
  });

  test("uses explicit filenames before URL extensions for kind inference", () => {
    const result = extractTgAttachments('<tg-attachment url="https://example.test/movie.mp4" filename="report.pdf" />');

    assert.deepEqual(result.warnings, []);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].kind, "document");
    assert.equal(result.attachments[0].label, "report.pdf");
  });
});
