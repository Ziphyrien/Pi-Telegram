// src/attachment.ts — parse AI attachment blocks and build grammY media inputs
import { existsSync, statSync } from "node:fs";
import { InputFile } from "grammy";

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

const TAG_RE = /<tg-attachment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tg-attachment>)/gi;
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

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(input)) !== null) {
    clean += input.slice(last, m.index);
    last = TAG_RE.lastIndex;
    idx += 1;

    const attrs = parseAttrs(m[1] ?? "");
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

    const rawContent = trimEdgeNewlines(m[2] ?? "");
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
    text: collapseGaps(clean).trim(),
    attachments,
    warnings,
  };
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw)) !== null) {
    attrs[m[1].toLowerCase().replace(/-/g, "_")] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

function normalizeKind(raw: string): TgAttachmentKind | undefined {
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
  const explicit = normalizeKind(forceKind);
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

function trimEdgeNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

function collapseGaps(s: string): string {
  return s
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}
