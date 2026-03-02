// src/reply-tool.ts — reply directive parsing + message memory resolution
import type { ReplyParameters } from "@grammyjs/types";

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
const TAG_RE = /<tg-reply\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tg-reply>)/gi;

export function rememberReplyMessage(
  scope: string,
  role: Exclude<ReplyRole, "any">,
  messageId: number,
  text: string,
): void {
  const body = normalizeText(text);
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

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(input)) !== null) {
    clean += input.slice(last, m.index);
    last = TAG_RE.lastIndex;

    if (!directive) {
      const attrs = parseAttrs(m[1] ?? "");
      directive = buildDirective(attrs, m[2] ?? "", warnings);
    } else {
      warnings.push("检测到多个 tg-reply 标签，仅使用第一个");
    }
  }

  clean += input.slice(last);

  return {
    text: collapseGaps(clean).trim(),
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

function buildDirective(
  attrs: Record<string, string>,
  body: string,
  warnings: string[],
): TgReplyDirective | undefined {
  const messageIdRaw = attrs.message_id || attrs.messageid || attrs.to_message_id || "";
  const messageId = Number.parseInt(messageIdRaw, 10);

  const role = normalizeRole(attrs.role || attrs.from || attrs.who || attrs.author || "");
  const contains = (attrs.contains || attrs.match || attrs.find || "").trim();
  const quoteAttr = (attrs.quote || attrs.text || "").trim();
  const quoteBody = normalizeText(body);
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

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw)) !== null) {
    attrs[m[1].toLowerCase().replace(/-/g, "_")] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

function normalizeText(s: string): string {
  return s.replace(/\r/g, "").trim();
}

function collapseGaps(s: string): string {
  return s
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}
