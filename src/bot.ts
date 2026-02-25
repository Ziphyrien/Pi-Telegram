// src/bot.ts — Telegram bot setup, only TG interaction logic
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrate, type HydrateFlavor } from "@grammyjs/hydrate";
import { CommandGroup } from "@grammyjs/commands";
import { autoChatAction, type AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { log } from "./log.js";
import { mdToTgHtml } from "./md2tg.js";
import { createBotMenus } from "./menu.js";

import {
  extractTgAttachments,
  type TgAttachment,
  type TgAttachmentKind,
} from "./attachment.js";
import {
  extractTgReplyDirective,
  rememberReplyMessage,
  resolveReplyParameters,
} from "./reply-tool.js";
import type { PiPool } from "./pool.js";
import type { BotConfig, PiImage } from "./types.js";

type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export interface CreateBotOptions {
  botIndex: number;
  config: BotConfig;
  pool: PiPool;
  maxResponseLength: number;
  initialStreamByChat?: Record<string, boolean>;
  onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;
}

export function createBot(opts: CreateBotOptions): Bot<BotContext> {
  const {
    botIndex,
    config,
    pool,
    maxResponseLength,
    initialStreamByChat,
    onStreamModeChange,
  } = opts;
  const bot = new Bot<BotContext>(config.token);
  const botKey = createHash("sha1").update(config.token).digest("hex").slice(0, 12);

  // --- plugins ---
  bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));
  bot.use(hydrate());
  bot.use(autoChatAction());

  // --- error handler ---
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      // Ignore stale callback query or idempotent edit
      if (e.description.includes("query is too old")) return;
      if (e.description.includes("message is not modified")) return;
      log.error(`bot${botIndex}`, `TG API: ${e.description}`);
    } else if (e instanceof HttpError) {
      log.error(`bot${botIndex}`, `HTTP: ${e}`);
    } else {
      log.error(`bot${botIndex}`, `${e}`);
    }
  });

  const menus = createBotMenus<BotContext>({
    botIndex,
    botKey,
    pool,
    outdatedMenuText: "菜单已更新，请重试",
    initialStreamByChat,
    onStreamModeChange,
  });

  const { modelMenu, streamMenu, thinkingMenu } = menus;
  bot.use(modelMenu);
  bot.use(streamMenu);
  bot.use(thinkingMenu);

  // Auth guard
  if (config.allowedUsers.length) {
    bot.use(async (tgCtx, next) => {
      const uid = tgCtx.from?.id;
      const uname = tgCtx.from?.username;
      if (config.allowedUsers.includes(uid!) || config.allowedUsers.includes(uname!)) {
        return next();
      }
      await tgCtx.reply("⛔ 无权限");
    });
  }

  const commandGroup = new CommandGroup<BotContext>();
  bot.use(commandGroup);

  commandGroup.command("status", "查看状态", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const key = chatKey(botKey, chatId);
    const inst = pool.has(key);
    const alive = inst?.alive ? "✅ 运行中" : "💤 未启动";
    const state = inst?.streaming ? "⏳ 处理中" : "🟢 空闲";
    let modelLabel = "默认";
    let providerLabel = "";
    let thinkingSupported = true;
    let thinkingLabel = "";
    let sessionLabel = "";
    let costLabel = "";

    if (inst?.alive) {
      try {
        const st = await inst.getState();
        menus.syncState(chatId, st);
        const m = st.model as any;
        if (m?.name) modelLabel = m.name;
        if (m?.provider) providerLabel = String(m.provider);
        if (typeof m?.reasoning === "boolean") {
          thinkingSupported = m.reasoning;
        }
        if (thinkingSupported && st.thinkingLevel) {
          thinkingLabel = String(st.thinkingLevel);
        }
        if (st.sessionId) sessionLabel = String(st.sessionId).slice(0, 8);
      } catch { /* ignore */ }

      try {
        const stats = await inst.getSessionStats();
        if (typeof stats.cost === "number" && stats.cost > 0) {
          costLabel = `💰 花费: $${formatCost(stats.cost)}`;
        }
      } catch { /* ignore */ }
    }

    const lines = [
      `${alive} | ${state}`,
      providerLabel ? `🏢 供应商: ${providerLabel}` : "",
      `🤖 模型: ${modelLabel}`,
      `⚙️ 输出: ${menus.isStreamEnabled(chatId) ? "流式" : "非流式"}`,
      thinkingLabel ? `🧠 思考: ${thinkingLabel}` : "",
      sessionLabel ? `🗂 会话: ${sessionLabel}` : "",
      costLabel,
      `📊 活跃: ${pool.size}`,
    ].filter(Boolean);

    await tgCtx.reply(lines.join("\n"));
  });

  commandGroup.command("new", "新建会话", async (tgCtx) => {
    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.has(key);
    if (inst?.alive) {
      inst.abortAll();
      inst.newSession();
      await tgCtx.reply("🆕 已新建会话");
    } else {
      pool.getFresh(key);
      await tgCtx.reply("🆕 已新建会话");
    }
  });

  commandGroup.command("abort", "中止当前操作", async (tgCtx) => {
    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.has(key);
    if (inst?.alive && inst.busy) {
      inst.abortAll();
    } else {
      await tgCtx.reply("当前无操作");
    }
  });


  commandGroup.command("model", "切换模型", async (tgCtx) => {
    const chatId = tgCtx.chat.id;

    try {
      await menus.refreshModelsForChat(chatId);
    } catch (err) {
      await tgCtx.reply(`❌ 获取模型列表失败：${(err as Error).message}`);
      return;
    }

    await tgCtx.reply("🔄 选择 Provider:", { reply_markup: modelMenu });
  });

  commandGroup.command("stream", "切换流式输出", async (tgCtx) => {
    await tgCtx.reply("⚙️ 输出模式:", { reply_markup: streamMenu });
  });

  commandGroup.command("thinking", "切换思考程度", async (tgCtx) => {
    const chatId = tgCtx.chat.id;
    const supported = await menus.supportsThinkingForChat(chatId);
    if (!supported) {
      await tgCtx.reply("当前模型不支持思考等级");
      return;
    }
    await menus.ensureThinkingForChat(chatId);
    await tgCtx.reply("🧠 思考程度:", { reply_markup: thinkingMenu });
  });

  type PromptPayload = { message: string; images?: PiImage[] };
  type PromptBuildOptions = { supportsImages: boolean };

  const imageSupportCache = new Map<number, { value: boolean; at: number }>();

  async function supportsImagesForChat(
    chatId: number,
    inst: ReturnType<PiPool["get"]>,
  ): Promise<boolean> {
    const cached = imageSupportCache.get(chatId);
    const now = Date.now();
    if (cached && now - cached.at < 30_000) return cached.value;

    let value = true;
    try {
      const st = await inst.getState();
      const model = (st as any)?.model;
      let parsed = parseModelImageSupport(model);

      if (typeof parsed !== "boolean" && model?.provider && model?.id) {
        try {
          const models = await inst.getAvailableModels();
          const selected = models.find(
            (m: any) => m.provider === model.provider && m.id === model.id,
          );
          parsed = parseModelImageSupport(selected);
        } catch {
          // ignore lookup failures
        }
      }

      if (typeof parsed === "boolean") value = parsed;
    } catch {
      // ignore and keep default true
    }

    imageSupportCache.set(chatId, { value, at: now });
    return value;
  }

  const reportStatusOrReply = async (
    tgCtx: BotContext,
    status: { editText: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
    text: string,
  ): Promise<void> => {
    const safe = truncate(text, 1500);
    try {
      await status.editText(safe);
    } catch {
      await tgCtx.reply(safe).catch(() => {});
    }
  };

  const runPromptRequest = async (
    tgCtx: BotContext,
    inst: ReturnType<PiPool["get"]>,
    makePayload: (opts: PromptBuildOptions) => Promise<PromptPayload>,
  ): Promise<void> => {
    const ahead = inst.queuedCount + (inst.running ? 1 : 0);
    const initialStatus = ahead > 0
      ? `⏳ 排队中（前方 ${ahead} 条）...`
      : "⏳ 思考中...";
    const status = await tgCtx.reply(initialStatus);

    const chatId = tgCtx.chat?.id ?? 0;
    const useStream = menus.isStreamEnabled(chatId);
    tgCtx.chatAction = "typing";
    const onStart = ahead > 0
      ? () => {
        void status.editText("⏳ 思考中...").catch(() => {});
      }
      : undefined;

    try {
      const supportsImages = await supportsImagesForChat(chatId, inst);
      const { message, images } = await makePayload({ supportsImages });
      const promptMessage = message;

      if (useStream) {
        const stream = createStreamUpdater(status, maxResponseLength);
        try {
          const result = await inst.prompt(promptMessage, images, {
            onStart,
            onTextDelta: stream.onTextDelta,
            onToolStart: stream.onToolStart,
            onToolError: stream.onToolError,
          });
          await finalizeReply(status, tgCtx, result.text, result.tools, maxResponseLength);
        } finally {
          // Stop pending stream timer before final render.
          stream.dispose();
        }
        return;
      }

      const result = await inst.prompt(promptMessage, images, { onStart });
      await status.delete().catch(() => {});
      await sendReply(tgCtx, result.text, result.tools, maxResponseLength);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await reportStatusOrReply(
        tgCtx,
        status,
        message === "aborted" ? "🛑 已中止" : `❌ 错误：${message}`,
      );
    } finally {
      tgCtx.chatAction = null;
    }
  };

  // Text messages
  bot.on("message:text", async (tgCtx) => {
    const text = tgCtx.message.text;
    if (!text || text.startsWith("/")) return;

    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message.message_id, text);
    rememberReferencedReply(tgCtx);

    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.get(key);

    await runPromptRequest(tgCtx, inst, async ({ supportsImages }) =>
      buildPromptPayloadWithReplyContext(tgCtx, text, config.token, supportsImages),
    );
  });

  // Photos
  bot.on("message:photo", async (tgCtx) => {
    const caption = tgCtx.message.caption || "请描述这张图片";
    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message.message_id, caption);
    rememberReferencedReply(tgCtx);

    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.get(key);

    await runPromptRequest(tgCtx, inst, async ({ supportsImages }) => {
      const photos = tgCtx.message.photo;
      const current = photos[photos.length - 1];
      const image = await downloadImageByFileId(
        tgCtx,
        config.token,
        current.file_id,
        "image/jpeg",
        supportsImages,
      );
      const currentImages = image ? [image] : [];

      return buildPromptPayloadWithReplyContext(
        tgCtx,
        caption,
        config.token,
        supportsImages,
        currentImages,
      );
    });
  });

  // Sync command menu from command group definitions
  commandGroup.setCommands(bot)
    .catch((err) => log.error(`bot${botIndex}`, `setCommands: ${err}`));

  return bot;
}

// --- helpers (private to this module) ---

function chatKey(botKey: string, chatId: number): string {
  return `bot${botKey}_chat${chatId}`;
}

function replyScopeKey(tgCtx: BotContext): string {
  return `${tgCtx.me.id}:${tgCtx.chat?.id ?? 0}`;
}

const inboundDirCache = new Set<string>();

function rememberReferencedReply(tgCtx: BotContext): void {
  const current = tgCtx.message as any;
  const replied = current?.reply_to_message as any;
  if (!replied?.message_id) return;

  const text = extractMessageText(replied) || String(current?.quote?.text || "").trim();
  if (!text) return;

  const role = replied?.from?.id === tgCtx.me.id ? "self" : "user";
  rememberReplyMessage(replyScopeKey(tgCtx), role, replied.message_id, text);
}

interface LoadedImage {
  fileId: string;
  localPath: string;
  contentHash?: string;
  image?: PiImage;
}

interface ReplyContextOptions {
  currentImagePaths?: string[];
  referencedImagePaths?: string[];
}

async function buildPromptPayloadWithReplyContext(
  tgCtx: BotContext,
  content: string,
  token: string,
  enableImages: boolean,
  currentImages: LoadedImage[] = [],
): Promise<{ message: string; images?: PiImage[] }> {
  const dedupeIds = new Set(currentImages.map((x) => x.fileId.toLowerCase()));
  const referencedImages = await collectReferencedImages(tgCtx, token, dedupeIds, enableImages);

  const deduped = dedupeLoadedImageGroups(currentImages, referencedImages);
  const message = buildUserMessageWithReplyContext(tgCtx, content, {
    currentImagePaths: toPromptPathList(deduped.current),
    referencedImagePaths: toPromptPathList(deduped.referenced),
  });

  return {
    message,
    images: enableImages
      ? deduped.all.flatMap((x) => (x.image ? [x.image] : []))
      : undefined,
  };
}

function buildUserMessageWithReplyContext(
  tgCtx: BotContext,
  content: string,
  opts: ReplyContextOptions = {},
): string {
  const current = tgCtx.message as any;
  const replied = current?.reply_to_message as any;
  const quote = String(current?.quote?.text || "").trim();
  const currentImagePaths = opts.currentImagePaths ?? [];
  const referencedImagePaths = opts.referencedImagePaths ?? [];

  const targetText = extractMessageText(replied);
  const targetFrom = formatMessageSender(replied, tgCtx.me.id);
  const hasUsefulReply =
    !!targetText
    || !!quote
    || referencedImagePaths.length > 0
    || currentImagePaths.length > 0;

  if (!hasUsefulReply) return content;

  const replyBlock = [
    "[回复上下文开始]",
    targetFrom ? `reply_to_sender: ${targetFrom}` : "",
    targetText ? `reply_to_text: ${truncate(targetText, 1200)}` : "",
    quote ? `user_selected_quote: ${truncate(quote, 500)}` : "",
    referencedImagePaths.length > 0
      ? `reply_to_image_paths:\n- ${referencedImagePaths.join("\n- ")}`
      : "",
    currentImagePaths.length > 0
      ? `current_image_paths:\n- ${currentImagePaths.join("\n- ")}`
      : "",
    referencedImagePaths.length > 0 || currentImagePaths.length > 0
      ? "附图顺序：先 current_images（如果有），再 reply_to_images。"
      : "",
    "[回复上下文结束]",
  ].filter(Boolean);

  return [
    ...replyBlock,
    "",
    "[用户真实请求]",
    content,
  ].join("\n");
}

async function collectReferencedImages(
  tgCtx: BotContext,
  token: string,
  seenFileIds: Set<string> = new Set(),
  includeImage = true,
): Promise<LoadedImage[]> {
  const current = tgCtx.message as any;
  const replied = current?.reply_to_message as any;
  if (!replied) return [];

  const images: LoadedImage[] = [];

  if (Array.isArray(replied.photo) && replied.photo.length > 0) {
    const photo = replied.photo[replied.photo.length - 1];
    const key = String(photo.file_id || "").toLowerCase();
    if (key && !seenFileIds.has(key)) {
      seenFileIds.add(key);
      const img = await downloadImageByFileId(tgCtx, token, photo.file_id, "image/jpeg", includeImage);
      if (img) images.push(img);
    }
  }

  if (replied.document?.file_id && String(replied.document?.mime_type || "").startsWith("image/")) {
    const key = String(replied.document.file_id || "").toLowerCase();
    if (key && !seenFileIds.has(key)) {
      seenFileIds.add(key);
      const img = await downloadImageByFileId(
        tgCtx,
        token,
        replied.document.file_id,
        String(replied.document?.mime_type || "image/jpeg"),
        includeImage,
      );
      if (img) images.push(img);
    }
  }

  return images;
}

async function downloadImageByFileId(
  tgCtx: BotContext,
  token: string,
  fileId: string,
  fallbackMimeType = "image/jpeg",
  includeImage = true,
): Promise<LoadedImage | null> {
  try {
    const file = await tgCtx.api.getFile(fileId);
    if (!file.file_path) return null;

    const filePath = String(file.file_path);
    const mimeType = inferImageMimeFromPath(filePath, fallbackMimeType);
    if (!mimeType.startsWith("image/")) return null;

    const ext = inferImageExtFromPath(filePath, mimeType);
    const localPath = resolveInboundImagePath(tgCtx, fileId, ext);

    let buffer: Buffer | null = null;

    const hasLocal = existsSync(localPath);

    // Only fetch when local file is missing.
    if (!hasLocal) {
      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      buffer = Buffer.from(await resp.arrayBuffer());
      await writeFile(localPath, buffer);
    }

    let contentHash: string | undefined;
    if (buffer) {
      contentHash = hashImageBuffer(buffer);
    }

    if (!includeImage) {
      return { fileId, localPath, contentHash };
    }

    if (!buffer) {
      buffer = await readFile(localPath);
      contentHash = hashImageBuffer(buffer);
    }

    return {
      fileId,
      localPath,
      contentHash,
      image: {
        type: "image",
        data: buffer.toString("base64"),
        mimeType,
      },
    };
  } catch {
    return null;
  }
}

function inferImageMimeFromPath(path: string, fallback: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return mimeMap[ext] || fallback;
}

function inferImageExtFromPath(path: string, mimeType: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (ext) return ext;
  return inferImageExtFromMime(mimeType);
}

function inferImageExtFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  return map[mimeType] || "img";
}

function hashImageBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function resolveInboundImagePath(
  tgCtx: BotContext,
  fileId: string,
  ext: string,
): string {
  const dir = resolve(
    homedir(),
    ".pi",
    "telegram",
    "inbound",
    String(tgCtx.me.id),
    String(tgCtx.chat?.id ?? 0),
  );
  if (!inboundDirCache.has(dir)) {
    mkdirSync(dir, { recursive: true });
    inboundDirCache.add(dir);
  }

  const filename = `${sanitizeFileToken(fileId)}.${sanitizeFileToken(ext || "img")}`;
  return resolve(dir, filename);
}

function sanitizeFileToken(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(0, 120) || "file";
}

function normalizePromptPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function extractMessageText(msg: any): string {
  if (!msg) return "";

  const text = String(msg.text || "").trim();
  const caption = String(msg.caption || "").trim();
  if (text && caption) return `${text}\n${caption}`;
  return text || caption;
}

function formatMessageSender(msg: any, meId: number): string {
  if (!msg) return "";
  if (msg.from?.id === meId) return "self";
  if (msg.from?.username) return `@${msg.from.username}`;
  if (msg.from?.first_name) return msg.from.first_name;
  if (msg.sender_chat?.title) return msg.sender_chat.title;
  return "user";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

interface DedupedImageGroups {
  current: LoadedImage[];
  referenced: LoadedImage[];
  all: LoadedImage[];
}

function ensureImageHash(img: LoadedImage): string | undefined {
  if (img.contentHash) return img.contentHash;
  if (!img.image) return undefined;
  img.contentHash = createHash("sha256").update(img.image.data).digest("hex");
  return img.contentHash;
}

function dedupeLoadedImageGroups(
  currentImages: LoadedImage[],
  referencedImages: LoadedImage[],
): DedupedImageGroups {
  const seenFileIds = new Set<string>();
  const seenHashes = new Set<string>();

  const current: LoadedImage[] = [];
  const referenced: LoadedImage[] = [];
  const all: LoadedImage[] = [];

  const push = (bucket: LoadedImage[], img: LoadedImage) => {
    const fid = String(img.fileId || "").toLowerCase();
    const hash = ensureImageHash(img);

    if (fid && seenFileIds.has(fid)) return;
    if (hash && seenHashes.has(hash)) return;

    if (fid) seenFileIds.add(fid);
    if (hash) seenHashes.add(hash);
    bucket.push(img);
    all.push(img);
  };

  for (const img of currentImages) push(current, img);
  for (const img of referencedImages) push(referenced, img);

  return { current, referenced, all };
}

function toPromptPathList(images: LoadedImage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const img of images) {
    const p = normalizePromptPath(img.localPath);
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  return out;
}

function parseModelImageSupport(model: any): boolean | undefined {
  if (!model || typeof model !== "object") return undefined;

  if (Array.isArray(model.input)) {
    return model.input.includes("image");
  }

  if (typeof model.supportsImages === "boolean") return model.supportsImages;
  if (typeof model.supportsVision === "boolean") return model.supportsVision;
  if (typeof model.vision === "boolean") return model.vision;
  if (typeof model.imageInput === "boolean") return model.imageInput;

  const caps = model.capabilities;
  if (caps && typeof caps === "object") {
    if (typeof caps.image === "boolean") return caps.image;
    if (typeof caps.images === "boolean") return caps.images;
    if (typeof caps.imageInput === "boolean") return caps.imageInput;
    if (typeof caps.vision === "boolean") return caps.vision;
  }

  return undefined;
}

interface StreamUpdater {
  onTextDelta: (delta: string, fullText: string) => void;
  onToolStart: (toolName?: string) => void;
  onToolError: (toolName?: string) => void;
  dispose: () => void;
}

function createStreamUpdater(
  status: { editText: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
  maxLen: number,
): StreamUpdater {
  const minEditIntervalMs = 700;
  // Reserve room for HTML tags/entities during streaming render
  const safeLimit = Math.min(Math.max(200, maxLen - 1000), 2800);
  let text = "";
  const tools: string[] = [];
  let lastRendered = "";
  let lastEditAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const preview = buildStreamingPreview(text, tools, safeLimit);
    if (!preview) return;

    const html = mdToTgHtml(preview);
    if (html === lastRendered) return;

    lastRendered = html;
    lastEditAt = Date.now();

    status.editText(html, { parse_mode: "HTML" }).catch(() => {
      status.editText(preview).catch(() => {});
    });
  };

  const scheduleRender = () => {
    if (disposed) return;
    const wait = minEditIntervalMs - (Date.now() - lastEditAt);
    if (wait <= 0) {
      render();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        render();
      }, wait);
    }
  };

  return {
    onTextDelta: (_delta, fullText) => {
      text = fullText;
      scheduleRender();
    },
    onToolStart: (toolName) => {
      if (toolName) tools.push(`🔧 ${toolName}`);
      scheduleRender();
    },
    onToolError: () => {
      if (tools.length > 0) {
        tools[tools.length - 1] = `${tools[tools.length - 1]} ❌`;
      } else {
        tools.push("🔧 执行失败 ❌");
      }
      scheduleRender();
    },
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function buildStreamingPreview(text: string, tools: string[], limit: number): string {
  const toolBlock = tools.length ? `${tools.join("\n")}\n\n` : "";
  const available = Math.max(32, limit - toolBlock.length);

  if (!text) return toolBlock.trim();
  if (text.length <= available) return `${toolBlock}${text}`;

  const tail = text.slice(-available);
  return `${toolBlock}…${tail}`;
}

function formatCost(cost: number): string {
  if (cost >= 1) return cost.toFixed(2);
  if (cost >= 0.01) return cost.toFixed(3);
  if (cost >= 0.001) return cost.toFixed(4);
  return cost.toPrecision(2);
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) { parts.push(rest); break; }
    let at = rest.lastIndexOf("\n", limit);
    if (at < limit * 0.3) at = limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return parts;
}

interface PreparedReply {
  body: string;
  attachments: TgAttachment[];
  warnings: string[];
  replyParameters?: ReplyParameters;
}

function prepareReply(tgCtx: BotContext, text: string, tools: string[]): PreparedReply {
  const extractedReply = extractTgReplyDirective(text || "");
  const extracted = extractTgAttachments(extractedReply.text);
  const resolvedReply = resolveReplyParameters(replyScopeKey(tgCtx), extractedReply.directive);
  let body = extracted.text;

  if (tools.length) {
    body = `${tools.join("\n")}${body ? `\n\n${body}` : ""}`;
  }

  if (!body.trim() && extracted.attachments.length === 0) {
    body = "(无回复)";
  }

  return {
    body,
    attachments: extracted.attachments,
    warnings: [...extractedReply.warnings, ...extracted.warnings, ...resolvedReply.warnings],
    replyParameters: resolvedReply.replyParameters,
  };
}

async function sendPreparedReply(
  tgCtx: BotContext,
  prepared: PreparedReply,
  maxLen: number,
): Promise<void> {
  let first = true;
  if (prepared.body.trim()) {
    for (const part of splitMessage(prepared.body, maxLen)) {
      const html = mdToTgHtml(part);
      const opts = first && prepared.replyParameters
        ? { reply_parameters: prepared.replyParameters }
        : undefined;
      try {
        const sent = await tgCtx.reply(html, { parse_mode: "HTML", ...(opts ?? {}) });
        rememberReplyMessage(replyScopeKey(tgCtx), "self", sent.message_id, part);
      } catch {
        const sent = await tgCtx.reply(part, opts);
        rememberReplyMessage(replyScopeKey(tgCtx), "self", sent.message_id, part);
      }
      first = false;
    }
  }

  await sendAttachments(
    tgCtx,
    prepared.attachments,
    prepared.warnings,
    first ? prepared.replyParameters : undefined,
  );
}

async function sendAttachments(
  tgCtx: BotContext,
  attachments: TgAttachment[],
  warnings: string[],
  replyParameters?: ReplyParameters,
): Promise<void> {
  if (warnings.length) {
    const preview = warnings.slice(0, 3).join("\n");
    const more = warnings.length > 3 ? `\n... 还有 ${warnings.length - 3} 条` : "";
    await tgCtx.reply(`⚠️ 附件解析告警：\n${preview}${more}`).catch(() => {});
  }

  let first = true;
  for (const att of attachments) {
    try {
      const opts = first && replyParameters
        ? { reply_parameters: replyParameters }
        : undefined;
      await sendOneAttachment(tgCtx, att, opts);
    } catch (err) {
      await tgCtx.reply(`❌ 附件发送失败：${att.label || "未知附件"}\n${(err as Error).message}`).catch(() => {});
    }
    first = false;
  }
}

type ReplyMethodName =
  | "replyWithPhoto"
  | "replyWithDocument"
  | "replyWithVideo"
  | "replyWithAudio"
  | "replyWithAnimation"
  | "replyWithVoice"
  | "replyWithVideoNote"
  | "replyWithSticker";

type MediaInput = TgAttachment["media"];
type SendOther = { reply_parameters?: ReplyParameters };

const REPLY_BY_KIND: Record<TgAttachmentKind, ReplyMethodName> = {
  photo: "replyWithPhoto",
  document: "replyWithDocument",
  video: "replyWithVideo",
  audio: "replyWithAudio",
  animation: "replyWithAnimation",
  voice: "replyWithVoice",
  video_note: "replyWithVideoNote",
  sticker: "replyWithSticker",
};

const REPLY_SENDER: Record<ReplyMethodName, (ctx: BotContext, media: MediaInput, other?: SendOther) => Promise<unknown>> = {
  replyWithPhoto: (ctx, media, other) => ctx.replyWithPhoto(media, other),
  replyWithDocument: (ctx, media, other) => ctx.replyWithDocument(media, other),
  replyWithVideo: (ctx, media, other) => ctx.replyWithVideo(media, other),
  replyWithAudio: (ctx, media, other) => ctx.replyWithAudio(media, other),
  replyWithAnimation: (ctx, media, other) => ctx.replyWithAnimation(media, other),
  replyWithVoice: (ctx, media, other) => ctx.replyWithVoice(media, other),
  replyWithVideoNote: (ctx, media, other) => ctx.replyWithVideoNote(media, other),
  replyWithSticker: (ctx, media, other) => ctx.replyWithSticker(media, other),
};

async function sendOneAttachment(
  tgCtx: BotContext,
  att: TgAttachment,
  other?: SendOther,
): Promise<void> {
  const method = REPLY_BY_KIND[att.kind] || "replyWithDocument";

  try {
    await REPLY_SENDER[method](tgCtx, att.media, other);
  } catch (err) {
    if (method === "replyWithDocument") throw err;
    await REPLY_SENDER.replyWithDocument(tgCtx, att.media, other);
  }
}

async function finalizeReply(
  status: {
    message_id?: number;
    editText: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
    delete: () => Promise<unknown>;
  },
  tgCtx: BotContext,
  text: string,
  tools: string[],
  maxLen: number,
): Promise<void> {
  const prepared = prepareReply(tgCtx, text, tools);
  const hasBody = prepared.body.trim().length > 0;
  const hasReplyTarget = !!prepared.replyParameters;

  if (!hasBody) {
    await status.delete().catch(() => {});
    await sendAttachments(
      tgCtx,
      prepared.attachments,
      prepared.warnings,
      prepared.replyParameters,
    );
    return;
  }

  const parts = splitMessage(prepared.body, maxLen);

  // Keep the streamed message as final output if it fits in one message
  // but only when no reply target is requested.
  if (!hasReplyTarget && parts.length === 1) {
    const html = mdToTgHtml(parts[0]);
    try {
      await status.editText(html, { parse_mode: "HTML" });
      if (typeof status.message_id === "number") {
        rememberReplyMessage(replyScopeKey(tgCtx), "self", status.message_id, parts[0]);
      }
      await sendAttachments(tgCtx, prepared.attachments, prepared.warnings);
      return;
    } catch {
      // fallback to normal send path
    }
  }

  await status.delete().catch(() => {});
  await sendPreparedReply(tgCtx, prepared, maxLen);
}

async function sendReply(
  tgCtx: BotContext,
  text: string,
  tools: string[],
  maxLen: number,
): Promise<void> {
  const prepared = prepareReply(tgCtx, text, tools);
  await sendPreparedReply(tgCtx, prepared, maxLen);
}
