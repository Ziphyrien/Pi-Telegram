import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Context } from "grammy";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import type { PiImage } from "../types.js";
import { rememberReplyMessage } from "./protocol.js";

type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export interface LoadedImage {
  fileId: string;
  localPath: string;
  contentHash?: string;
  image?: PiImage;
}

const inboundDirectories = new Set<string>();

export async function downloadImageByFileId(
  context: BotContext,
  token: string,
  fileId: string,
  fallbackMimeType = "image/jpeg",
  includeImage = true,
  inboundBaseDir = homedir(),
): Promise<LoadedImage | null> {
  const loaded = await downloadInboundFileByFileId(
    context,
    token,
    fileId,
    fallbackMimeType,
    includeImage,
    inboundBaseDir,
  );
  return loaded?.image ? loaded : null;
}

export async function downloadInboundFileByFileId(
  context: BotContext,
  token: string,
  fileId: string,
  fallbackMimeType = "application/octet-stream",
  includeImage = true,
  inboundBaseDir = homedir(),
): Promise<LoadedImage | null> {
  try {
    const file = await context.api.getFile(fileId) as any;
    if (!file?.file_path) return null;

    const filePath = String(file.file_path);
    const mimeType = inferImageMimeFromPath(filePath, fallbackMimeType);
    const localPath = resolveInboundImagePath(context, fileId, inferImageExtFromPath(filePath, mimeType), inboundBaseDir);
    let buffer: Buffer | null = null;

    if (!existsSync(localPath)) {
      if (typeof file.download === "function") {
        try {
          await file.download(localPath);
        } catch {
          buffer = await fetchInboundFile(token, filePath, localPath);
          if (!buffer) return null;
        }
      } else {
        buffer = await fetchInboundFile(token, filePath, localPath);
        if (!buffer) return null;
      }
    }

    const isImage = mimeType.startsWith("image/");
    if (includeImage && isImage) {
      buffer ??= await readFile(localPath);
      return {
        fileId,
        localPath,
        contentHash: hashImageBuffer(buffer),
        image: { type: "image", data: buffer.toString("base64"), mimeType },
      };
    }

    const contentHash = isImage
      ? hashImageBuffer(buffer ?? await readFile(localPath))
      : undefined;
    return { fileId, localPath, contentHash };
  } catch {
    return null;
  }
}

async function fetchInboundFile(token: string, filePath: string, localPath: string): Promise<Buffer | null> {
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(localPath, buffer);
  return buffer;
}

export function inferImageMimeFromPath(path: string, fallback: string): string {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  const mimeByExtension: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return mimeByExtension[extension] || fallback;
}

export function inferImageExtFromPath(path: string, mimeType: string): string {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  return extension || inferImageExtFromMime(mimeType);
}

export function inferImageExtFromMime(mimeType: string): string {
  const extensionByMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  return extensionByMime[mimeType] || "img";
}

function hashImageBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function resolveInboundImagePath(
  context: BotContext,
  fileId: string,
  extension: string,
  inboundBaseDir: string,
): string {
  const directory = resolve(
    inboundBaseDir,
    ".pi",
    "telegram",
    "inbound",
    String(context.me.id),
    String(context.chat?.id ?? 0),
  );
  if (!inboundDirectories.has(directory)) {
    mkdirSync(directory, { recursive: true });
    inboundDirectories.add(directory);
  }

  return resolve(directory, `${sanitizeFileToken(fileId)}.${sanitizeFileToken(extension || "img")}`);
}

export function sanitizeFileToken(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(0, 120) || "file";
}

export function normalizePromptPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export interface DedupedImageGroups {
  current: LoadedImage[];
  referenced: LoadedImage[];
  all: LoadedImage[];
}

function ensureImageHash(image: LoadedImage): string | undefined {
  if (image.contentHash) return image.contentHash;
  if (!image.image) return undefined;
  image.contentHash = hashImageBuffer(Buffer.from(image.image.data));
  return image.contentHash;
}

export function dedupeLoadedImageGroups(currentImages: LoadedImage[], referencedImages: LoadedImage[]): DedupedImageGroups {
  const seenFileIds = new Set<string>();
  const seenHashes = new Set<string>();
  const current: LoadedImage[] = [];
  const referenced: LoadedImage[] = [];
  const all: LoadedImage[] = [];

  const add = (target: LoadedImage[], image: LoadedImage): void => {
    const fileId = String(image.fileId || "").toLowerCase();
    const hash = ensureImageHash(image);
    if ((fileId && seenFileIds.has(fileId)) || (hash && seenHashes.has(hash))) return;

    if (fileId) seenFileIds.add(fileId);
    if (hash) seenHashes.add(hash);
    target.push(image);
    all.push(image);
  };

  currentImages.forEach((image) => add(current, image));
  referencedImages.forEach((image) => add(referenced, image));
  return { current, referenced, all };
}

export function toPromptPathList(images: LoadedImage[]): string[] {
  return normalizePromptPathList(images.map((image) => image.localPath));
}

export function normalizePromptPathList(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawPath of paths) {
    const path = normalizePromptPath(String(rawPath || "").trim());
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(path);
  }
  return normalized;
}

export function parseModelImageSupport(model: unknown): boolean | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record = model as Record<string, unknown>;
  if (Array.isArray(record.input)) return record.input.includes("image");

  for (const key of ["supportsImages", "supportsVision", "vision", "imageInput"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }

  const capabilities = record.capabilities;
  if (!capabilities || typeof capabilities !== "object") return undefined;
  for (const key of ["image", "images", "imageInput", "vision"] as const) {
    const value = (capabilities as Record<string, unknown>)[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function chatKey(botKey: string, chatId: number): string {
  return `bot${botKey}_chat${chatId}`;
}

export function replyScopeKey(context: BotContext): string {
  return `${context.me.id}:${context.chat?.id ?? 0}`;
}

export function extractMessageText(message: any): string {
  if (!message) return "";

  const text = String(message.text || "").trim();
  const caption = String(message.caption || "").trim();
  if (text && caption) return `${text}\n${caption}`;
  return text || caption;
}

export function formatMessageSender(message: any, meId: number): string {
  if (!message) return "";
  if (message.from?.id === meId) return "self";
  if (message.from?.username) return `@${message.from.username}`;
  if (message.from?.first_name) return message.from.first_name;
  if (message.sender_chat?.title) return message.sender_chat.title;
  return "user";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}


export interface ReplyContextOptions {
  currentImagePaths?: string[];
  referencedImagePaths?: string[];
  currentFilePaths?: string[];
}

export function rememberReferencedReply(context: BotContext): void {
  const message = context.message as any;
  const replied = message?.reply_to_message as any;
  if (!replied?.message_id) return;

  const text = extractMessageText(replied) || String(message?.quote?.text || "").trim();
  if (!text) return;

  const role = replied.from?.id === context.me.id ? "self" : "user";
  rememberReplyMessage(replyScopeKey(context), role, replied.message_id, text);
}

export async function buildPromptPayloadWithReplyContext(
  context: BotContext,
  content: string,
  token: string,
  includeImages: boolean,
  currentImages: LoadedImage[] = [],
  currentFilePaths: string[] = [],
): Promise<{ message: string; images?: PiImage[] }> {
  const knownFileIds = new Set(currentImages.map((image) => image.fileId.toLowerCase()));
  const referencedImages = await collectReferencedImages(context, token, knownFileIds, includeImages);
  const groups = dedupeLoadedImageGroups(currentImages, referencedImages);
  const filePaths = normalizePromptPathList([
    ...currentFilePaths,
    ...toPromptPathList(groups.current),
  ]);

  let images: PiImage[] | undefined;
  if (includeImages) {
    images = [];
    for (const image of groups.all) {
      if (image.image) images.push(image.image);
    }
  }

  return {
    message: buildUserMessageWithReplyContext(context, content, {
      currentImagePaths: toPromptPathList(groups.current),
      referencedImagePaths: toPromptPathList(groups.referenced),
      currentFilePaths: filePaths,
    }),
    images,
  };
}

export function buildUserMessageWithReplyContext(
  context: BotContext,
  content: string,
  options: ReplyContextOptions = {},
): string {
  const message = context.message as any;
  const replied = message?.reply_to_message as any;
  const quote = String(message?.quote?.text || "").trim();
  const referencedImagePaths = options.referencedImagePaths ?? [];
  const currentImagePaths = options.currentImagePaths ?? [];
  const currentFilePaths = options.currentFilePaths ?? [];
  const targetText = extractMessageText(replied);
  const targetSender = formatMessageSender(replied, context.me.id);

  const hasContext = Boolean(
    targetText || quote || referencedImagePaths.length || currentImagePaths.length || currentFilePaths.length,
  );
  if (!hasContext) return content;

  const contextLines = [
    "[回复上下文开始]",
    targetSender ? `reply_to_sender: ${targetSender}` : "",
    targetText ? `reply_to_text: ${truncate(targetText, 1200)}` : "",
    quote ? `user_selected_quote: ${truncate(quote, 500)}` : "",
    referencedImagePaths.length ? `reply_to_image_paths:\n- ${referencedImagePaths.join("\n- ")}` : "",
    currentImagePaths.length ? `current_image_paths:\n- ${currentImagePaths.join("\n- ")}` : "",
    currentFilePaths.length ? `current_file_paths:\n- ${currentFilePaths.join("\n- ")}` : "",
    referencedImagePaths.length || currentImagePaths.length
      ? "附图顺序：先 current_images（如果有），再 reply_to_images。"
      : "",
    "[回复上下文结束]",
  ].filter(Boolean);
  return [...contextLines, "", "[用户真实请求]", content].join("\n");
}

async function collectReferencedImages(
  context: BotContext,
  token: string,
  seenFileIds: Set<string>,
  includeImage: boolean,
): Promise<LoadedImage[]> {
  const replied = (context.message as any)?.reply_to_message as any;
  if (!replied) return [];

  const references: Array<{ fileId: string; mimeType: string }> = [];
  if (Array.isArray(replied.photo) && replied.photo.length) {
    references.push({ fileId: String(replied.photo.at(-1)?.file_id || ""), mimeType: "image/jpeg" });
  }
  if (replied.document?.file_id && String(replied.document.mime_type || "").startsWith("image/")) {
    references.push({ fileId: String(replied.document.file_id), mimeType: String(replied.document.mime_type || "image/jpeg") });
  }

  const images: LoadedImage[] = [];
  for (const reference of references) {
    const key = reference.fileId.toLowerCase();
    if (!key || seenFileIds.has(key)) continue;
    seenFileIds.add(key);
    const image = await downloadImageByFileId(context, token, reference.fileId, reference.mimeType, includeImage);
    if (image) images.push(image);
  }
  return images;
}
