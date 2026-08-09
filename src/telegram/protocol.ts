import { existsSync, statSync } from "node:fs";
import { InputFile } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";

export type TgAttachmentKind =
  | "photo"
  | "document"
  | "video"
  | "audio"
  | "animation"
  | "voice"
  | "video_note"
  | "sticker";

export interface TgAttachment {
  kind: TgAttachmentKind;
  media: string | InputFile; // file_id or InputFile(URL/Buffer/...)
  label: string;
}

export interface AttachmentExtraction {
  text: string;
  attachments: TgAttachment[];
  warnings: string[];
}

const ATTACHMENT_TAG_RE = /<tg-attachment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tg-attachment>)/gi;
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

const PHOTO_EXT = new Set(["jpg", "jpeg", "png", "bmp", "tif", "tiff"]);
const ANIMATION_EXT = new Set(["gif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "webm", "m4v", "avi"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "wav", "aac", "flac", "oga"]);
const VOICE_EXT = new Set(["ogg", "opus"]);
const STICKER_EXT = new Set(["webp", "tgs", "webm"]);

export function extractTgAttachments(input: string): AttachmentExtraction {
  const attachments: TgAttachment[] = [];
  const warnings: string[] = [];
  const usedNames = new Set<string>();

  let last = 0;
  let clean = "";
  let idx = 0;
  let m: RegExpExecArray | null;

  ATTACHMENT_TAG_RE.lastIndex = 0;
  while ((m = ATTACHMENT_TAG_RE.exec(input)) !== null) {
    clean += input.slice(last, m.index);
    last = ATTACHMENT_TAG_RE.lastIndex;
    idx += 1;

    const attrs = parseTagAttributes(m[1] ?? "");
    const encoding = (attrs.encoding || "text").toLowerCase();
    const forceKind = attrs.as || attrs.kind || attrs.media || attrs.method || attrs.type || "";

    const fileId = (attrs.file_id || attrs.fileid || attrs.id || "").trim();
    const url = (attrs.url || attrs.src || attrs.link || "").trim();
    const localPath = (attrs.path || attrs.file_path || attrs.filepath || "").trim();

    let filename = "";
    const rawName = attrs.filename || attrs.name || "";
    if (rawName) {
      filename = dedupeName(sanitizeFilename(rawName, idx), usedNames);
    } else if (url) {
      const inferred = inferFilenameFromUrl(url, idx);
      if (inferred) filename = dedupeName(inferred, usedNames);
    } else if (localPath) {
      const inferred = inferFilenameFromPath(localPath, idx);
      if (inferred) filename = dedupeName(inferred, usedNames);
    }

    const kind = resolveKind(forceKind, filename, url, localPath);
    const label = filename || url || fileId || localPath || `attachment-${idx}`;

    if (fileId) {
      attachments.push({ kind, media: fileId, label });
      continue;
    }

    if (url) {
      if (!isValidHttpUrl(url)) {
        warnings.push(`附件 ${label} 的 URL 非法`);
        continue;
      }
      try {
        const media = filename
          ? new InputFile(new URL(url), filename)
          : new InputFile(new URL(url));
        attachments.push({ kind, media, label });
      } catch {
        warnings.push(`附件 ${label} 的 URL 解析失败`);
      }
      continue;
    }

    if (localPath) {
      if (!existsSync(localPath)) {
        warnings.push(`附件 ${label} 的本地路径不存在`);
        continue;
      }
      let size = 0;
      try {
        const st = statSync(localPath);
        if (!st.isFile()) {
          warnings.push(`附件 ${label} 的本地路径不是文件`);
          continue;
        }
        size = st.size;
      } catch {
        warnings.push(`附件 ${label} 的本地路径无法读取`);
        continue;
      }

      if (size > MAX_UPLOAD_BYTES) {
        warnings.push(`附件 ${label} 超过大小限制（>${MAX_UPLOAD_BYTES} bytes）`);
        continue;
      }

      const media = filename ? new InputFile(localPath, filename) : new InputFile(localPath);
      attachments.push({ kind, media, label });
      continue;
    }

    const rawContent = trimTagBody(m[2] ?? "");
    let data: Buffer;

    if (encoding === "base64") {
      try {
        const compact = rawContent.replace(/\s+/g, "");
        if (!compact) throw new Error("empty base64 payload");
        const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
        data = Buffer.from(normalized, "base64");
        if (!data.length) throw new Error("decoded bytes is empty");
      } catch (err) {
        warnings.push(`附件 ${label} 解析失败：${(err as Error).message}`);
        continue;
      }
    } else {
      data = Buffer.from(rawContent, "utf8");
    }

    if (data.byteLength > MAX_UPLOAD_BYTES) {
      warnings.push(`附件 ${label} 超过大小限制（>${MAX_UPLOAD_BYTES} bytes）`);
      continue;
    }

    if (!filename) {
      filename = dedupeName(defaultFilename(kind, encoding, idx), usedNames);
    }

    attachments.push({
      kind,
      media: new InputFile(data, filename),
      label: filename,
    });
  }

  clean += input.slice(last);

  return {
    text: collapseTagGaps(clean).trim(),
    attachments,
    warnings,
  };
}

function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const matcher = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(raw)) !== null) {
    attrs[match[1].toLowerCase().replace(/-/g, "_")] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

function trimTagBody(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

function collapseTagGaps(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
}

function normalizeAttachmentKind(raw: string): TgAttachmentKind | undefined {
  const k = raw.trim().toLowerCase().replace(/-/g, "_");
  if (!k) return undefined;
  if (k === "photo" || k === "image" || k === "pic") return "photo";
  if (k === "document" || k === "file" || k === "doc") return "document";
  if (k === "video") return "video";
  if (k === "audio" || k === "music") return "audio";
  if (k === "animation" || k === "gif") return "animation";
  if (k === "voice" || k === "ptt") return "voice";
  if (k === "video_note" || k === "videonote" || k === "round_video") return "video_note";
  if (k === "sticker") return "sticker";
  return undefined;
}

function resolveKind(
  forceKind: string,
  filename: string,
  url: string,
  localPath: string,
): TgAttachmentKind {
  const explicit = normalizeAttachmentKind(forceKind);
  if (explicit) return explicit;

  const ext = extOf(filename) || extOfUrl(url) || extOfPath(localPath);
  if (!ext) return "document";
  if (STICKER_EXT.has(ext)) return "sticker";
  if (ANIMATION_EXT.has(ext)) return "animation";
  if (PHOTO_EXT.has(ext)) return "photo";
  if (VIDEO_EXT.has(ext)) return "video";
  if (VOICE_EXT.has(ext)) return "voice";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "document";
}

function defaultFilename(kind: TgAttachmentKind, encoding: string, idx: number): string {
  if (encoding === "text") return `attachment-${idx}.txt`;
  switch (kind) {
    case "photo": return `attachment-${idx}.jpg`;
    case "video": return `attachment-${idx}.mp4`;
    case "audio": return `attachment-${idx}.mp3`;
    case "animation": return `attachment-${idx}.gif`;
    case "voice": return `attachment-${idx}.ogg`;
    case "video_note": return `attachment-${idx}.mp4`;
    case "sticker": return `attachment-${idx}.webp`;
    default: return `attachment-${idx}.bin`;
  }
}

function sanitizeFilename(name: string, idx: number): string {
  let s = name.trim().replace(/^['"]+|['"]+$/g, "");
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  if (!s || s === "." || s === "..") {
    s = `attachment-${idx}.txt`;
  }
  if (s.length > 140) {
    const dot = s.lastIndexOf(".");
    if (dot > 0 && dot < s.length - 1) {
      const ext = s.slice(dot);
      s = `${s.slice(0, 140 - ext.length)}${ext}`;
    } else {
      s = s.slice(0, 140);
    }
  }
  return s;
}

function dedupeName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";

  let n = 2;
  while (true) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    n += 1;
  }
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function extOfUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return extOf(u.pathname);
  } catch {
    return "";
  }
}

function extOfPath(localPath: string): string {
  if (!localPath) return "";
  return extOf(localPath.replace(/\\/g, "/"));
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function inferFilenameFromUrl(url: string, idx: number): string | undefined {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split("/").pop() || "").trim();
    if (!seg) return undefined;
    return sanitizeFilename(seg, idx);
  } catch {
    return undefined;
  }
}

function inferFilenameFromPath(localPath: string, idx: number): string | undefined {
  const normalized = localPath.replace(/\\/g, "/");
  const seg = normalized.split("/").pop()?.trim() || "";
  if (!seg) return undefined;
  return sanitizeFilename(seg, idx);
}



export type ReplyRole = "self" | "user" | "any";

export interface TgReplyDirective {
  messageId?: number;
  role: ReplyRole;
  contains?: string;
  quote?: string;
}

export interface ReplyDirectiveExtraction {
  text: string;
  directive?: TgReplyDirective;
  warnings: string[];
}

interface MemoryEntry {
  messageId: number;
  role: Exclude<ReplyRole, "any">;
  text: string;
  ts: number;
}

const histories = new Map<string, MemoryEntry[]>();
const MAX_HISTORY = 300;
const REPLY_TAG_RE = /<tg-reply\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tg-reply>)/gi;

export function rememberReplyMessage(
  scope: string,
  role: Exclude<ReplyRole, "any">,
  messageId: number,
  text: string,
): void {
  const body = normalizeReplyText(text);
  if (!body) return;

  const list = histories.get(scope) ?? [];
  list.push({ messageId, role, text: body, ts: Date.now() });
  if (list.length > MAX_HISTORY) {
    list.splice(0, list.length - MAX_HISTORY);
  }
  histories.set(scope, list);
}

export function extractTgReplyDirective(input: string): ReplyDirectiveExtraction {
  const warnings: string[] = [];
  let directive: TgReplyDirective | undefined;

  let last = 0;
  let clean = "";
  let m: RegExpExecArray | null;

  REPLY_TAG_RE.lastIndex = 0;
  while ((m = REPLY_TAG_RE.exec(input)) !== null) {
    clean += input.slice(last, m.index);
    last = REPLY_TAG_RE.lastIndex;

    if (!directive) {
      const attrs = parseTagAttributes(m[1] ?? "");
      directive = buildReplyDirective(attrs, m[2] ?? "", warnings);
    } else {
      warnings.push("检测到多个 tg-reply 标签，仅使用第一个");
    }
  }

  clean += input.slice(last);

  return {
    text: collapseTagGaps(clean).trim(),
    directive,
    warnings,
  };
}

export function resolveReplyParameters(
  scope: string,
  directive?: TgReplyDirective,
): { replyParameters?: ReplyParameters; warnings: string[] } {
  const warnings: string[] = [];
  if (!directive) return { warnings };

  const list = histories.get(scope) ?? [];
  if (!list.length) {
    warnings.push("回复工具未找到可引用的历史消息");
    return { warnings };
  }

  const target = selectTarget(list, directive);
  if (!target) {
    warnings.push("回复工具未匹配到目标消息，已退化为普通回复");
    return { warnings };
  }

  const params: ReplyParameters = {
    message_id: target.messageId,
    allow_sending_without_reply: true,
  };

  const quoteSeed = (directive.quote || directive.contains || "").trim();
  if (quoteSeed) {
    const quote = quoteSeed.slice(0, 1024);
    const pos = target.text.indexOf(quote);
    if (pos >= 0) {
      params.quote = quote;
      params.quote_position = pos;
    } else {
      warnings.push("回复工具未匹配到 quote 片段，已仅按消息回复");
    }
  }

  return { replyParameters: params, warnings };
}

function selectTarget(list: MemoryEntry[], directive: TgReplyDirective): MemoryEntry | undefined {
  if (directive.messageId) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].messageId === directive.messageId) {
        return list[i];
      }
    }
    return undefined;
  }

  const contains = (directive.contains || "").trim();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (directive.role !== "any" && item.role !== directive.role) continue;
    if (contains && !item.text.includes(contains)) continue;
    return item;
  }

  return undefined;
}

function buildReplyDirective(
  attrs: Record<string, string>,
  body: string,
  warnings: string[],
): TgReplyDirective | undefined {
  const messageIdRaw = attrs.message_id || attrs.messageid || attrs.to_message_id || "";
  const messageId = Number.parseInt(messageIdRaw, 10);

  const role = normalizeRole(attrs.role || attrs.from || attrs.who || attrs.author || "");
  const contains = (attrs.contains || attrs.match || attrs.find || "").trim();
  const quoteAttr = (attrs.quote || attrs.text || "").trim();
  const quoteBody = normalizeReplyText(body);
  const quote = quoteAttr || quoteBody || undefined;

  if (!Number.isNaN(messageId) && messageId > 0) {
    return {
      messageId,
      role,
      contains: contains || undefined,
      quote,
    };
  }

  if (!contains && !quote) {
    warnings.push("tg-reply 缺少定位信息（message_id 或 contains/quote）");
    return undefined;
  }

  return {
    role,
    contains: contains || undefined,
    quote,
  };
}

function normalizeRole(raw: string): ReplyRole {
  const r = raw.trim().toLowerCase();
  if (r === "self" || r === "bot" || r === "assistant") return "self";
  if (r === "user" || r === "human") return "user";
  return "any";
}

function normalizeReplyText(s: string): string {
  return s.replace(/\r/g, "").trim();
}

export type TgCronAction = "add" | "list" | "stat" | "on" | "off" | "del" | "run" | "rename";
export type TgCronKind = "at" | "every" | "cron";

export interface TgCronDirective {
  action: TgCronAction;
  id?: string;
  kind?: TgCronKind;
  name?: string;
  prompt?: string;
  at?: string;
  every?: string;
  expr?: string;
  timezone?: string;
}

export interface CronDirectiveExtraction {
  text: string;
  directives: TgCronDirective[];
  warnings: string[];
}

const CRON_TAG_RE = /<tg-cron\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tg-cron>)/gi;

export function extractTgCronDirectives(input: string): CronDirectiveExtraction {
  const directives: TgCronDirective[] = [];
  const warnings: string[] = [];

  let last = 0;
  let clean = "";
  let m: RegExpExecArray | null;

  CRON_TAG_RE.lastIndex = 0;
  while ((m = CRON_TAG_RE.exec(input)) !== null) {
    clean += input.slice(last, m.index);
    last = CRON_TAG_RE.lastIndex;

    if (directives.length >= 8) {
      warnings.push("tg-cron 指令过多，仅处理前 8 条");
      continue;
    }

    const attrs = parseTagAttributes(m[1] ?? "");
    const body = trimTagBody(m[2] ?? "");

    const built = buildCronDirective(attrs, body, warnings);
    if (built) directives.push(built);
  }

  clean += input.slice(last);

  return {
    text: collapseTagGaps(clean).trim(),
    directives,
    warnings,
  };
}

function buildCronDirective(
  attrs: Record<string, string>,
  body: string,
  warnings: string[],
): TgCronDirective | undefined {
  const actionRaw = attrs.action || attrs.op || attrs.cmd || attrs.type || "";
  const action = normalizeAction(actionRaw);
  if (!action) {
    warnings.push(`tg-cron 缺少或不支持 action: ${actionRaw || "(empty)"}`);
    return undefined;
  }

  if (action === "list" || action === "stat") {
    return { action };
  }

  const id = String(attrs.id || attrs.job_id || attrs.jobid || "").trim();
  if (action === "on" || action === "off" || action === "del" || action === "run") {
    if (!id) {
      warnings.push(`tg-cron action=${action} 缺少 id`);
      return undefined;
    }
    return { action, id };
  }

  if (action === "rename") {
    if (!id) {
      warnings.push("tg-cron action=rename 缺少 id");
      return undefined;
    }

    const name = String(attrs.name || attrs.title || body || "").trim();
    if (!name) {
      warnings.push("tg-cron action=rename 缺少 name/title 或标签体内容");
      return undefined;
    }

    return { action, id, name };
  }

  const kindRaw = attrs.kind || attrs.schedule || "";
  const kind = normalizeKind(kindRaw);
  if (!kind) {
    warnings.push(`tg-cron add 缺少或不支持 kind: ${kindRaw || "(empty)"}`);
    return undefined;
  }

  const prompt = String(attrs.prompt || attrs.message || attrs.task || body || "").trim();
  if (!prompt) {
    warnings.push("tg-cron add 缺少 prompt/message/task 或标签体内容");
    return undefined;
  }

  const name = String(attrs.name || attrs.title || "").trim() || undefined;
  const at = String(attrs.at || attrs.time || attrs.datetime || "").trim() || undefined;
  const every = String(attrs.every || attrs.interval || "").trim() || undefined;
  const expr = String(attrs.expr || attrs.cron || attrs.schedule_expr || "").trim() || undefined;
  const timezone = String(attrs.timezone || attrs.tz || "").trim() || undefined;

  if (kind === "at" && !at) {
    warnings.push("tg-cron add kind=at 缺少 at 时间");
    return undefined;
  }

  if (kind === "every" && !every) {
    warnings.push("tg-cron add kind=every 缺少 every 间隔");
    return undefined;
  }

  if (kind === "cron" && !expr) {
    warnings.push("tg-cron add kind=cron 缺少 expr 表达式");
    return undefined;
  }

  return {
    action,
    kind,
    name,
    prompt,
    at,
    every,
    expr,
    timezone,
  };
}

function normalizeAction(raw: string): TgCronAction | undefined {
  const s = raw.trim().toLowerCase().replace(/[-_\s]+/g, "");
  if (!s) return undefined;

  if (s === "add" || s === "create" || s === "new") return "add";
  if (s === "list" || s === "ls") return "list";
  if (s === "stat" || s === "status") return "stat";
  if (s === "on" || s === "enable") return "on";
  if (s === "off" || s === "disable") return "off";
  if (s === "del" || s === "rm" || s === "remove" || s === "delete") return "del";
  if (s === "run" || s === "trigger") return "run";
  if (s === "rename" || s === "name") return "rename";

  return undefined;
}

function normalizeKind(raw: string): TgCronKind | undefined {
  const s = raw.trim().toLowerCase().replace(/[-_\s]+/g, "");
  if (!s) return undefined;

  if (s === "at" || s === "oneshot" || s === "one") return "at";
  if (s === "every" || s === "interval" || s === "periodic") return "every";
  if (s === "cron") return "cron";

  return undefined;
}

