import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildRichMessage,
  buildRichThinkingMessage,
  buildStreamingPreview,
  buildUserMessageWithReplyContext,
  callSendRichMessageDraft,
  createDraftPreviewModel,
  createDraftStreamUpdater,
  dedupeLoadedImageGroups,
  downloadImageByFileId,
  downloadInboundFileByFileId,
  extractCommandArgs,
  extractMessageText,
  formatCompactDuration,
  formatCronJobLine,
  formatCronSchedule,
  formatCronStatus,
  formatMessageSender,
  inferImageExtFromMime,
  inferImageExtFromPath,
  inferImageMimeFromPath,
  looksLikeTimezone,
  normalizePromptPath,
  normalizePromptPathList,
  parseDurationMs,
  parseModelImageSupport,
  parseNamedPrompt,
  prepareCronReply,
  prepareReply,
  sanitizeFileToken,
  sendOneAttachment,
  sendPreparedReply,
  splitCommandArgs,
  splitMessage,
  stripProtocolTags,
  toPromptPathList,
  truncate,
  type LoadedImage,
} from "../../src/telegram/create-bot.js";
import type { TgAttachment } from "../../src/telegram/attachment.js";
import type { CronJobRecord } from "../../src/cron/types.js";
import { rememberReplyMessage } from "../../src/telegram/reply.js";

// @covers telegram/create-bot.ts

describe("create-bot pure helpers", () => {
  const flushDraftStream = () => new Promise((resolve) => setImmediate(resolve));

  function createReplyContext() {
    let nextMessageId = 100;
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const ctx = {
      me: { id: 10 },
      chat: { id: 20, type: "group" },
      calls,
      reply: async (text: unknown, options?: unknown) => {
        calls.push({ method: "reply", args: [text, options] });
        nextMessageId += 1;
        return { message_id: nextMessageId };
      },
      replyWithRichMessage: async (...args: unknown[]) => {
        calls.push({ method: "rich", args });
        nextMessageId += 1;
        return { message_id: nextMessageId };
      },
      replyWithPhoto: async (...args: unknown[]) => {
        calls.push({ method: "photo", args });
      },
      replyWithDocument: async (...args: unknown[]) => {
        calls.push({ method: "document", args });
      },
      replyWithVideo: async (...args: unknown[]) => {
        calls.push({ method: "video", args });
      },
      replyWithAudio: async (...args: unknown[]) => {
        calls.push({ method: "audio", args });
      },
      replyWithAnimation: async (...args: unknown[]) => {
        calls.push({ method: "animation", args });
      },
      replyWithVoice: async (...args: unknown[]) => {
        calls.push({ method: "voice", args });
      },
      replyWithVideoNote: async (...args: unknown[]) => {
        calls.push({ method: "video_note", args });
      },
      replyWithSticker: async (...args: unknown[]) => {
        calls.push({ method: "sticker", args });
      },
    };
    return ctx;
  }

  function createFileContext(file: unknown) {
    return {
      me: { id: 101 },
      chat: { id: 202 },
      api: {
        getFile: async () => file,
      },
    };
  }

  test("strips bridge protocol tags including dangling and escaped forms", () => {
    const input = 'hello <tg-reply contains="x" /> <tg-attachment>body</tg-attachment> &lt;tg-cron action="list" /&gt; <tg-cron action="add"';

    assert.equal(stripProtocolTags(input), "hello  body  ");
  });

  test("builds streaming previews with tool blocks and tail truncation", () => {
    assert.equal(buildStreamingPreview("hello", ["🔧 read"], 100), "🔧 read\n\nhello");
    assert.equal(buildStreamingPreview("abcdefghijklmnopqrstuvwxyz", [], 8), "abcdefghijklmnopqrstuvwxyz");
    assert.equal(buildStreamingPreview("abcdefghijklmnopqrstuvwxyz0123456789", [], 8), "…efghijklmnopqrstuvwxyz0123456789");
  });

  test("draft preview model renders Rich Markdown and memoizes unchanged previews", () => {
    const preview = createDraftPreviewModel(1000);
    assert.equal(preview.render(), null);

    preview.onTextDelta("", "**bold**");
    preview.onToolStart("read");
    preview.onToolError();

    const first = preview.render();
    assert.deepEqual(first?.richMessage, { markdown: "🔧 read ❌\n\n**bold**" });
    assert.equal(preview.render(), first);

    preview.onTextDelta("", "second");
    const second = preview.render();
    assert.notEqual(second, first);
    assert.deepEqual(second?.richMessage, { markdown: "🔧 read ❌\n\nsecond" });
  });

  test("draft preview model renders unnamed tool failures", () => {
    const preview = createDraftPreviewModel(1000);

    preview.onToolError();
    const first = preview.render();

    assert.deepEqual(first?.richMessage, { markdown: "🔧 执行失败 ❌" });

    preview.onToolStart("write-file");
    preview.onToolError();
    const second = preview.render();

    assert.equal(second?.richMessage.markdown, "🔧 执行失败 ❌\n🔧 write-file ❌");
  });

  test("draft preview model strips protocol tags and ignores empty previews", () => {
    const preview = createDraftPreviewModel(1000);

    preview.onTextDelta("", '<tg-reply contains="secret" /> &lt;tg-cron action="list" /&gt;');
    assert.equal(preview.render(), null);

    preview.onTextDelta("", '<tg-reply contains="secret" /> visible <tg-cron action="list" />');
    const rendered = preview.render();

    assert.match(rendered?.richMessage.markdown ?? "", /visible/);
    assert.doesNotMatch(rendered?.richMessage.markdown ?? "", /tg-(reply|cron)|secret/);
  });

  test("draft preview model keeps long drafts inside Bot API limits", () => {
    const preview = createDraftPreviewModel(10_000);
    preview.onTextDelta("", `${"a".repeat(5_000)}THE_END`);

    const rendered = preview.render();

    assert.ok(rendered);
    assert.ok(rendered.richMessage.markdown);
    assert.ok(rendered.richMessage.markdown.length <= 4096);
    assert.match(rendered.richMessage.markdown, /^…/);
    assert.match(rendered.richMessage.markdown, /THE_END$/);
  });

  test("draft preview model invalidates cached renders after text changes", () => {
    const preview = createDraftPreviewModel(1000);

    preview.onTextDelta("", "first");
    const first = preview.render();
    assert.equal(preview.render(), first);

    preview.onTextDelta("", "second");
    const second = preview.render();

    assert.notEqual(second, first);
    assert.equal(second?.richMessage.markdown, "second");
  });

  test("sends rich drafts through grammY's typed API", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendRichMessageDraft: async (...args: unknown[]) => {
        calls.push(args);
      },
    };

    await callSendRichMessageDraft(api as never, 123, 4, buildRichMessage("**draft**"), 99);

    assert.deepEqual(calls, [[123, 4, { markdown: "**draft**" }, { message_thread_id: 99 }]]);
  });

  test("preserves CJK and Rich Markdown syntax for Telegram", () => {
    const markdown = "# 中文标题\n\n这是 **粗体** 和 `代码`。\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文 | ✅ |\n\n<details open><summary>展开</summary>内容</details>";

    assert.deepEqual(buildRichMessage(markdown), { markdown });
  });

  test("builds the native Rich Thinking block", () => {
    assert.deepEqual(buildRichThinkingMessage(), {
      blocks: [{ type: "thinking", text: "Thinking..." }],
    });
  });

  test("omits invalid message thread ids for rich drafts", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendRichMessageDraft: async (...args: unknown[]) => {
        calls.push(args);
      },
    };

    await callSendRichMessageDraft(api as never, 123, 6, buildRichMessage("draft"), 0);

    assert.deepEqual(calls, [[123, 6, { markdown: "draft" }, undefined]]);
  });

  test("draft stream updater sends Thinking and Rich Markdown previews", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendRichMessageDraft: async (...args: unknown[]) => {
        calls.push(args);
      },
    };
    const stream = createDraftStreamUpdater(api as never, 1, 2, 3, 1000, undefined, 0);

    stream.onStart();
    await flushDraftStream();
    stream.onTextDelta("", "**answer**");
    await flushDraftStream();
    await stream.stopAndWait();

    assert.deepEqual(calls, [
      [1, 2, { blocks: [{ type: "thinking", text: "Thinking..." }] }, { message_thread_id: 3 }],
      [1, 2, { markdown: "**answer**" }, { message_thread_id: 3 }],
    ]);
  });

  test("draft stream updater disables itself after a Rich draft error", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const api = {
      sendRichMessageDraft: async (_chatId: unknown, _draftId: unknown, richMessage: unknown) => {
        calls.push((richMessage as { markdown?: string }).markdown ?? "");
        throw new Error("draft request failed");
      },
    };
    const stream = createDraftStreamUpdater(api as never, 1, 2, undefined, 1000, (err) => errors.push(err), 0);

    stream.onTextDelta("", "first");
    await flushDraftStream();
    stream.onTextDelta("", "second");
    await flushDraftStream();
    await stream.stopAndWait();

    assert.deepEqual(calls, ["first"]);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /draft request failed/);
  });

  test("draft stream updater ignores not-modified errors and stops after send errors", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const api = {
      sendRichMessageDraft: async (_chatId: unknown, _draftId: unknown, richMessage: unknown) => {
        const markdown = (richMessage as { markdown?: string }).markdown ?? "";
        calls.push(markdown);
        if (markdown.includes("same")) throw new Error("message is not modified");
        throw new Error("draft request failed");
      },
    };

    const unchanged = createDraftStreamUpdater(api as never, 1, 2, undefined, 1000, (err) => errors.push(err), 0);
    unchanged.onTextDelta("", "same");
    await flushDraftStream();
    await unchanged.stopAndWait();

    const failed = createDraftStreamUpdater(api as never, 1, 2, undefined, 1000, (err) => errors.push(err), 0);
    failed.onToolError();
    await flushDraftStream();
    await failed.stopAndWait();

    assert.deepEqual(calls, ["same", "🔧 执行失败 ❌"]);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /draft request failed/);
  });

  test("splits long messages near newline boundaries and truncates strings", () => {
    assert.deepEqual(splitMessage("abc\ndef\nghi", 7), ["abc\ndef", "\nghi"]);
    assert.deepEqual(splitMessage("abcdefgh", 3), ["abc", "def", "gh"]);
    assert.equal(truncate("abcdef", 4), "abcd…");
    assert.equal(truncate("abc", 4), "abc");
  });

  test("builds user message with reply, quote, image, and file context", () => {
    const ctx = {
      me: { id: 1 },
      chat: { id: 99 },
      message: {
        quote: { text: "selected quote" },
        reply_to_message: {
          text: "reply text",
          caption: "reply caption",
          from: { id: 2, username: "alice" },
        },
      },
    } as never;

    const result = buildUserMessageWithReplyContext(ctx, "do work", {
      currentImagePaths: ["C:/tmp/current.png"],
      referencedImagePaths: ["C:/tmp/reply.png"],
      currentFilePaths: ["C:/tmp/doc.txt"],
    });

    assert.match(result, /reply_to_sender: @alice/);
    assert.match(result, /reply_to_text: reply text\nreply caption/);
    assert.match(result, /user_selected_quote: selected quote/);
    assert.match(result, /current_image_paths:\n- C:\/tmp\/current\.png/);
    assert.match(result, /reply_to_image_paths:\n- C:\/tmp\/reply\.png/);
    assert.match(result, /current_file_paths:\n- C:\/tmp\/doc\.txt/);
    assert.match(result, /\[用户真实请求\]\ndo work$/);
  });

  test("formats message sender and extracts message text", () => {
    assert.equal(formatMessageSender({ from: { id: 1 } }, 1), "self");
    assert.equal(formatMessageSender({ from: { id: 2, username: "bob" } }, 1), "@bob");
    assert.equal(formatMessageSender({ from: { id: 2, first_name: "Bob" } }, 1), "Bob");
    assert.equal(formatMessageSender({ sender_chat: { title: "Channel" } }, 1), "Channel");
    assert.equal(formatMessageSender({}, 1), "user");
    assert.equal(extractMessageText({ text: " hello ", caption: " cap " }), "hello\ncap");
    assert.equal(extractMessageText({ caption: " cap " }), "cap");
  });

  test("infers and sanitizes image/file paths", () => {
    assert.equal(inferImageMimeFromPath("photo.JPG", "fallback"), "image/jpeg");
    assert.equal(inferImageMimeFromPath("file.bin", "fallback"), "fallback");
    assert.equal(inferImageExtFromPath("/tmp/file", "image/png"), "/tmp/file");
    assert.equal(inferImageExtFromPath("", "image/png"), "png");
    assert.equal(inferImageExtFromMime("image/webp"), "webp");
    assert.equal(inferImageExtFromMime("application/octet-stream"), "img");
    assert.equal(sanitizeFileToken("a/b:c?d"), "a_b_c_d");
    assert.equal(sanitizeFileToken("*"), "_");
    assert.equal(normalizePromptPath("C:\\tmp\\a.png"), "C:/tmp/a.png");
    assert.deepEqual(normalizePromptPathList([" C:\\A ", "c:/a", "", "D:/b"]), ["C:/A", "D:/b"]);
  });

  test("sanitizes file tokens with length limits and fallback names", () => {
    assert.equal(sanitizeFileToken("   "), "___");
    assert.equal(sanitizeFileToken("***"), "___");
    assert.equal(sanitizeFileToken(""), "file");
    assert.equal(sanitizeFileToken("a".repeat(200)).length, 120);
  });

  test("normalizes prompt path lists by trimming, slashes, and case-insensitive duplicates", () => {
    assert.deepEqual(normalizePromptPathList([" ./A.PNG ", ".\\a.png", "../B.jpg", "../b.JPG", "C:\\dir\\file.txt"]), [
      "./A.PNG",
      "../B.jpg",
      "C:/dir/file.txt",
    ]);
  });

  test("infers image extensions and mime fallbacks case-sensitively where documented", () => {
    assert.equal(inferImageMimeFromPath("archive.tar.PNG", "fallback"), "image/png");
    assert.equal(inferImageMimeFromPath("no-extension", "fallback"), "fallback");
    assert.equal(inferImageExtFromPath("photo.JPEG", "image/png"), "jpeg");
    assert.equal(inferImageExtFromMime("IMAGE/PNG"), "img");
  });

  test("downloads inbound image files through grammY file download", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-download-"));
    const imageBytes = Buffer.from("image-bytes");
    const file = {
      file_path: "photos/original.JPG",
      download: async (localPath: string) => {
        mkdirSync(join(localPath, ".."), { recursive: true });
        writeFileSync(localPath, imageBytes);
      },
    };

    const loaded = await downloadImageByFileId(createFileContext(file) as never, "TOKEN", "file/id:1", "image/jpeg", true, inboundBaseDir);

    assert.equal(loaded?.fileId, "file/id:1");
    assert.equal(basename(loaded?.localPath ?? ""), "file_id_1.jpg");
    assert.equal(loaded?.image?.mimeType, "image/jpeg");
    assert.equal(loaded?.image?.data, imageBytes.toString("base64"));
    assert.ok(loaded?.contentHash);
  });

  test("falls back to Telegram file fetch when file download fails", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-fetch-"));
    const previousFetch = globalThis.fetch;
    const urls: string[] = [];
    const fetchedBytes = Buffer.from("fetched-image");
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return {
        ok: true,
        arrayBuffer: async () => fetchedBytes.buffer.slice(fetchedBytes.byteOffset, fetchedBytes.byteOffset + fetchedBytes.byteLength),
      } as Response;
    }) as unknown as typeof fetch;

    try {
      const loaded = await downloadImageByFileId(createFileContext({
        file_path: "photos/fallback.png",
        download: async () => { throw new Error("download unavailable"); },
      }) as never, "BOT:TOKEN", "fetch-id", "image/jpeg", true, inboundBaseDir);

      assert.equal(urls[0], "https://api.telegram.org/file/botBOT:TOKEN/photos/fallback.png");
      assert.equal(loaded?.image?.mimeType, "image/png");
      assert.equal(loaded?.image?.data, fetchedBytes.toString("base64"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("uses cached inbound files without re-downloading", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-cache-"));
    let downloadCalls = 0;
    const ctx = createFileContext({
      file_path: "photos/cached.webp",
      download: async (localPath: string) => {
        downloadCalls += 1;
        mkdirSync(join(localPath, ".."), { recursive: true });
        writeFileSync(localPath, Buffer.from("cached-image"));
      },
    }) as never;

    const first = await downloadImageByFileId(ctx, "TOKEN", "cached-id", "image/jpeg", true, inboundBaseDir);
    const second = await downloadImageByFileId(ctx, "TOKEN", "cached-id", "image/jpeg", true, inboundBaseDir);

    assert.equal(downloadCalls, 1);
    assert.equal(second?.localPath, first?.localPath);
    assert.equal(second?.image?.data, Buffer.from("cached-image").toString("base64"));
  });

  test("downloads inbound documents as file paths when image injection is disabled", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-file-"));
    const fileBytes = Buffer.from("plain document");
    const loaded = await downloadInboundFileByFileId(createFileContext({
      file_path: "docs/report.txt",
      download: async (localPath: string) => {
        mkdirSync(join(localPath, ".."), { recursive: true });
        writeFileSync(localPath, fileBytes);
      },
    }) as never, "TOKEN", "doc-id", "application/octet-stream", false, inboundBaseDir);

    assert.equal(loaded?.fileId, "doc-id");
    assert.equal(basename(loaded?.localPath ?? ""), "doc-id.txt");
    assert.equal(loaded?.image, undefined);
    assert.equal(loaded?.contentHash, undefined);
  });

  test("keeps image file paths and hashes when image injection is disabled", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-image-path-"));
    const imageBytes = Buffer.from("image without prompt payload");
    const loaded = await downloadInboundFileByFileId(createFileContext({
      file_path: "photos/path-only.jpg",
      download: async (localPath: string) => {
        mkdirSync(join(localPath, ".."), { recursive: true });
        writeFileSync(localPath, imageBytes);
      },
    }) as never, "TOKEN", "img-path-id", "image/jpeg", false, inboundBaseDir);

    assert.equal(loaded?.fileId, "img-path-id");
    assert.equal(loaded?.image, undefined);
    assert.ok(loaded?.contentHash);
  });

  test("downloadImageByFileId returns null for non-image files", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-non-image-"));
    const loaded = await downloadImageByFileId(createFileContext({
      file_path: "docs/readme.txt",
      download: async (localPath: string) => {
        mkdirSync(join(localPath, ".."), { recursive: true });
        writeFileSync(localPath, Buffer.from("not an image"));
      },
    }) as never, "TOKEN", "text-id", "application/octet-stream", true, inboundBaseDir);

    assert.equal(loaded, null);
  });

  test("returns null for missing Telegram file paths", async () => {
    const loaded = await downloadInboundFileByFileId(createFileContext({}) as never, "TOKEN", "missing-path", "image/jpeg", true, mkdtempSync(join(tmpdir(), "pitg-inbound-missing-")));

    assert.equal(loaded, null);
  });

  test("returns null when fallback Telegram file fetch fails", async () => {
    const inboundBaseDir = mkdtempSync(join(tmpdir(), "pitg-inbound-fetch-fail-"));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false } as Response)) as unknown as typeof fetch;

    try {
      const loaded = await downloadInboundFileByFileId(createFileContext({
        file_path: "photos/missing.png",
        download: async () => { throw new Error("download unavailable"); },
      }) as never, "TOKEN", "fetch-fail", "image/png", true, inboundBaseDir);

      assert.equal(loaded, null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("deduplicates loaded images by file id, hash, and path lists", () => {
    const current: LoadedImage[] = [
      { fileId: "A", localPath: "C:\\one.png", image: { type: "image", data: Buffer.from("one").toString("base64"), mimeType: "image/png" } },
      { fileId: "a", localPath: "C:\\duplicate-id.png", image: { type: "image", data: Buffer.from("two").toString("base64"), mimeType: "image/png" } },
    ];
    const referenced: LoadedImage[] = [
      { fileId: "B", localPath: "C:\\same-hash.png", image: { type: "image", data: Buffer.from("one").toString("base64"), mimeType: "image/png" } },
      { fileId: "C", localPath: "C:\\three.png", image: { type: "image", data: Buffer.from("three").toString("base64"), mimeType: "image/png" } },
    ];

    const deduped = dedupeLoadedImageGroups(current, referenced);

    assert.deepEqual(deduped.current.map((img) => img.fileId), ["A"]);
    assert.deepEqual(deduped.referenced.map((img) => img.fileId), ["C"]);
    assert.deepEqual(toPromptPathList(deduped.all), ["C:/one.png", "C:/three.png"]);
  });

  test("parses command arguments, names, durations, and timezones", () => {
    assert.equal(extractCommandArgs('/cron@my_bot add every 10m "do work"', "cron"), 'add every 10m "do work"');
    assert.deepEqual(splitCommandArgs('add cron "0 9 * * *" Asia/Shanghai \'daily report\''), ["add", "cron", "0 9 * * *", "Asia/Shanghai", "daily report"]);
    assert.deepEqual(parseNamedPrompt("Morning||write report"), { name: "Morning", prompt: "write report" });
    assert.deepEqual(parseNamedPrompt("no separator"), { prompt: "no separator" });
    assert.equal(parseDurationMs("1d2h3m4s"), 93_784_000);
    assert.equal(parseDurationMs("500ms"), undefined);
    assert.equal(parseDurationMs("0s"), undefined);
    assert.equal(looksLikeTimezone("UTC+8"), true);
    assert.equal(looksLikeTimezone("Asia/Shanghai"), true);
    assert.equal(looksLikeTimezone("not a timezone"), false);
  });

  test("extracts command args case-insensitively and leaves non-matching text unchanged", () => {
    assert.equal(extractCommandArgs("/CRON@Bot_Name list", "cron"), "list");
    assert.equal(extractCommandArgs("/crontab list", "cron"), "tab list");
    assert.equal(extractCommandArgs("hello /cron list", "cron"), "hello /cron list");
  });

  test("splits malformed quoted command args permissively", () => {
    assert.deepEqual(splitCommandArgs('add every 5m "unfinished prompt'), ["add", "every", "5m", '"unfinished', "prompt"]);
    assert.deepEqual(splitCommandArgs("add 'unterminated quoted"), ["add", "'unterminated", "quoted"]);
  });

  test("formats cron schedules, jobs, and status", () => {
    assert.equal(formatCompactDuration(90_061_000), "1d1h1m1s");
    assert.match(formatCronSchedule({ kind: "at", atMs: 1_700_000_000_000 }), /^at /);
    assert.match(formatCronSchedule({ kind: "every", everyMs: 90_000, anchorMs: 1_700_000_000_000 }), /^every 1m30s/);
    assert.equal(formatCronSchedule({ kind: "cron", expr: "0 9 * * *", timezone: "UTC" }), 'cron "0 9 * * *" @UTC');

    const job: CronJobRecord = {
      id: "job1",
      botName: "bot",
      chatId: 1,
      name: "A very long job name that should still be visible",
      prompt: "prompt",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
      policy: { maxLatenessMs: 1, retryMax: 1, retryBackoffMs: 1000, deleteAfterRun: true },
      state: { nextRunAtMs: 1_700_000_000_000, runningRunId: "run", lastStatus: "error", lastError: "x".repeat(80), consecutiveFailures: 2 },
    };

    assert.match(formatCronJobLine(job), /🟢 job1 ⏳running/);
    assert.match(formatCronJobLine(job), /last=error/);
    assert.match(formatCronJobLine(job), /err=x{40}…/);
    assert.match(formatCronStatus({ enabled: true, totalJobs: 2, enabledJobs: 1, runningJobs: 1, queuedJobs: 3, nextRunAtMs: 1_700_000_000_000 }), /总任务：2/);
  });

  test("parses model image support variants", () => {
    assert.equal(parseModelImageSupport({ input: ["text", "image"] }), true);
    assert.equal(parseModelImageSupport({ supportsImages: false }), false);
    assert.equal(parseModelImageSupport({ supportsVision: true }), true);
    assert.equal(parseModelImageSupport({ vision: false }), false);
    assert.equal(parseModelImageSupport({ imageInput: true }), true);
    assert.equal(parseModelImageSupport({ capabilities: { images: true } }), true);
    assert.equal(parseModelImageSupport({ capabilities: { vision: false } }), false);
    assert.equal(parseModelImageSupport({}), undefined);
  });

  test("prepares cron replies by stripping reply directives and collecting attachments", () => {
    const prepared = prepareCronReply(
      'body <tg-reply contains="x" /> <tg-attachment filename="a.txt">hello</tg-attachment>',
      ["🔧 tool"],
    );

    assert.equal(prepared.body, "🔧 tool\n\nbody");
    assert.equal(prepared.attachments.length, 1);
    assert.equal(prepared.attachments[0].label, "a.txt");
    assert.deepEqual(prepared.warnings, []);
    assert.equal(prepareCronReply("", []).body, "(无回复)");
  });

  test("prepares user replies with tools, attachments, reply parameters, and warnings", () => {
    const ctx = { me: { id: 77 }, chat: { id: 88 } } as never;
    rememberReplyMessage("77:88", "user", 321, "hello target quote");

    const prepared = prepareReply(
      ctx,
      'body <tg-reply from="user" contains="target" quote="target" /> <tg-attachment filename="a.txt">file body</tg-attachment>',
      ["🔧 read"],
      ["extra warning"],
    );

    assert.equal(prepared.body, "🔧 read\n\nbody");
    assert.equal(prepared.attachments.length, 1);
    assert.equal(prepared.attachments[0].label, "a.txt");
    assert.deepEqual(prepared.replyParameters, {
      message_id: 321,
      allow_sending_without_reply: true,
      quote: "target",
      quote_position: 6,
    });
    assert.deepEqual(prepared.warnings, ["extra warning"]);
  });

  test("prepareReply falls back to a placeholder for empty text with no attachments", () => {
    const prepared = prepareReply({ me: { id: 1 }, chat: { id: 2 } } as never, "", [], []);

    assert.equal(prepared.body, "(无回复)");
    assert.deepEqual(prepared.attachments, []);
    assert.deepEqual(prepared.warnings, []);
  });

  test("prepareReply merges reply and attachment warnings", () => {
    const prepared = prepareReply(
      { me: { id: 3 }, chat: { id: 4 } } as never,
      '<tg-reply from="user" /> <tg-attachment url="ftp://example.test/a.txt" />',
      [],
      ["extra warning"],
    );

    assert.equal(prepared.body, "(无回复)");
    assert.deepEqual(prepared.attachments, []);
    assert.match(prepared.warnings.join("\n"), /tg-reply 缺少定位信息/);
    assert.match(prepared.warnings.join("\n"), /URL 非法/);
    assert.match(prepared.warnings.join("\n"), /extra warning/);
  });

  test("sendOneAttachment falls back to document for media send failures", async () => {
    const calls: string[] = [];
    const ctx = {
      replyWithPhoto: async () => {
        calls.push("photo");
        throw new Error("photo rejected");
      },
      replyWithDocument: async (_media: unknown, other: unknown) => {
        calls.push(`document:${JSON.stringify(other)}`);
      },
    };
    const attachment: TgAttachment = { kind: "photo", media: "FILE_ID", label: "pic.jpg" };
    const replyParameters = { message_id: 10, allow_sending_without_reply: true };

    await sendOneAttachment(ctx as never, attachment, { reply_parameters: replyParameters });

    assert.deepEqual(calls, [`photo`, `document:${JSON.stringify({ reply_parameters: replyParameters })}`]);
  });

  test("sendPreparedReply sends Rich Markdown and keeps attachments separate", async () => {
    const ctx = createReplyContext();
    const replyParameters = { message_id: 42, allow_sending_without_reply: true };
    const attachment: TgAttachment = { kind: "document", media: "FILE_ID", label: "doc.txt" };
    const body = "# title\n\n| a | b |\n|---|---|\n| 1 | 2 |";

    await sendPreparedReply(ctx as never, {
      body,
      attachments: [attachment],
      warnings: [],
      replyParameters,
    }, 1000);

    assert.deepEqual(ctx.calls, [
      { method: "rich", args: [{ markdown: body }, { reply_parameters: replyParameters }] },
      { method: "document", args: ["FILE_ID", undefined] },
    ]);
  });

  test("sendPreparedReply splits long body and only replies to the first part", async () => {
    const ctx = createReplyContext();
    const replyParameters = { message_id: 42, allow_sending_without_reply: true };

    await sendPreparedReply(ctx as never, { body: "abcdef", attachments: [], warnings: [], replyParameters }, 3);

    assert.deepEqual(ctx.calls.map((call) => call.args), [
      [{ markdown: "abc" }, { reply_parameters: replyParameters }],
      [{ markdown: "def" }, undefined],
    ]);
  });

  test("sendPreparedReply truncates warning previews before attachments", async () => {
    const ctx = createReplyContext();
    const attachment: TgAttachment = { kind: "document", media: "FILE_ID", label: "doc.txt" };

    await sendPreparedReply(ctx as never, {
      body: "",
      attachments: [attachment],
      warnings: ["w1", "w2", "w3", "w4", "w5"],
    }, 1000);

    assert.equal(ctx.calls[0].method, "reply");
    assert.equal(ctx.calls[0].args[0], "⚠️ 附件解析告警：\nw1\nw2\nw3\n... 还有 2 条");
    assert.deepEqual(ctx.calls[1], { method: "document", args: ["FILE_ID", undefined] });
  });

  test("sendPreparedReply reports attachment send failures", async () => {
    const ctx = createReplyContext();
    ctx.replyWithDocument = async () => {
      ctx.calls.push({ method: "document", args: [] });
      throw new Error("upload failed");
    };
    const attachment: TgAttachment = { kind: "document", media: "FILE_ID", label: "doc.txt" };

    await sendPreparedReply(ctx as never, { body: "", attachments: [attachment], warnings: [] }, 1000);

    assert.deepEqual(ctx.calls, [
      { method: "document", args: [] },
      { method: "reply", args: ["❌ 附件发送失败：doc.txt\nupload failed", undefined] },
    ]);
  });

  test("parses escaped command quotes and preserves invalid named-prompt separators", () => {
    assert.deepEqual(splitCommandArgs(String.raw`add every 5m "say \"hello\"" 'it\'s ok'`), [
      "add",
      "every",
      "5m",
      'say "hello"',
      "it's ok",
    ]);
    assert.deepEqual(parseNamedPrompt("Name||"), { prompt: "Name||" });
    assert.deepEqual(parseNamedPrompt("||prompt only"), { name: undefined, prompt: "prompt only" });
  });

  test("rejects malformed durations and accepts spaced compound durations", () => {
    assert.equal(parseDurationMs("1 h 30 m"), 5_400_000);
    assert.equal(parseDurationMs("1h bad"), undefined);
    assert.equal(parseDurationMs("-1h"), undefined);
    assert.equal(parseDurationMs("999"), undefined);
  });

  test("formats disabled cron jobs and empty next-run status", () => {
    const job: CronJobRecord = {
      id: "job2",
      botName: "bot",
      chatId: 1,
      name: "short",
      prompt: "prompt",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "at", atMs: 0 },
      policy: { maxLatenessMs: 1, retryMax: 1, retryBackoffMs: 1000, deleteAfterRun: true },
      state: { nextRunAtMs: 0, consecutiveFailures: 0 },
    };

    assert.match(formatCronJobLine(job), /⚪ job2/);
    assert.match(formatCronJobLine(job), /next=-/);
    assert.match(formatCronStatus({ enabled: false, totalJobs: 0, enabledJobs: 0, runningJobs: 0, queuedJobs: 0 }), /最近下次触发：-/);
  });
});
