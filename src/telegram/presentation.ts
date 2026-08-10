import { GrammyError, HttpError, type Context } from "grammy";
import type { ReplyParameters } from "@grammyjs/types";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import type { PiSessionStats, CronJobRecord, CronSchedule, SchedulerStatus } from "../types.js";
import type { TgAttachment, TgAttachmentKind } from "./protocol.js";
import { extractTgAttachments, extractTgReplyDirective, resolveReplyParameters, rememberReplyMessage } from "./protocol.js";
import { replyScopeKey, truncate } from "./media.js";
import { t } from "../i18n.js";

interface CronStatusSummary {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
}

type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;
type SendRichMessageDraftOther = NonNullable<Parameters<BotContext["api"]["sendRichMessageDraft"]>[3]>;

export function describeTelegramSendError(error: unknown): string {
  if (error instanceof GrammyError) return error.description;
  if (error instanceof HttpError) return String(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isMessageNotModifiedError(error: unknown): boolean {
  return describeTelegramSendError(error).toLowerCase().includes("message is not modified");
}

export interface StreamUpdater {
  onStart: () => void;
  onTextDelta: (delta: string, fullText: string) => void;
  onToolStart: (toolName?: string) => void;
  onToolError: (toolName?: string) => void;
  stopAndWait: () => Promise<void>;
  dispose: () => void;
}

interface DraftPreviewRenderResult {
  richMessage: InputRichMessageWithoutUpload;
  renderKey: string;
}

export interface DraftPreviewModel {
  onTextDelta: (delta: string, fullText: string) => void;
  onToolStart: (toolName?: string) => void;
  onToolError: () => void;
  render: () => DraftPreviewRenderResult | null;
}

export function buildRichMessage(text: string): InputRichMessageWithoutUpload {
  return { markdown: text || t("(无回复)") };
}

export function buildRichThinkingMessage(): InputRichMessageWithoutUpload {
  return { blocks: [{ type: "thinking", text: "Thinking..." }] };
}

export function createDraftPreviewModel(maxLen: number): DraftPreviewModel {
  const safeLimit = Math.min(Math.max(200, maxLen - 600), 3800);
  let text = "";
  const tools: string[] = [];
  let lastPreview = "";
  let lastResult: DraftPreviewRenderResult | null = null;

  const toolBlock = () => tools.length ? `${tools.join("\n")}\n\n` : "";

  return {
    onTextDelta: (_delta, fullText) => {
      text = stripProtocolTags(fullText);
    },
    onToolStart: (toolName) => {
      if (toolName) tools.push(`🔧 ${toolName}`);
    },
    onToolError: () => {
      if (tools.length) {
        tools[tools.length - 1] = `${tools[tools.length - 1]} ❌`;
      } else {
        tools.push(t("🔧 执行失败 ❌"));
      }
    },
    render: () => {
      const preview = buildStreamingPreviewWithToolBlock(text, toolBlock(), safeLimit);
      if (!preview.trim()) {
        lastPreview = "";
        lastResult = null;
        return null;
      }
      if (preview === lastPreview) return lastResult;

      lastPreview = preview;
      lastResult = { richMessage: buildRichMessage(preview), renderKey: `rich:${preview}` };
      return lastResult;
    },
  };
}

export async function callSendRichMessageDraft(
  api: BotContext["api"],
  chatId: number,
  draftId: number,
  richMessage: InputRichMessageWithoutUpload,
  messageThreadId?: number,
): Promise<void> {
  const other: SendRichMessageDraftOther = {};
  if (Number.isSafeInteger(messageThreadId) && (messageThreadId as number) > 0) {
    other.message_thread_id = messageThreadId as number;
  }
  await api.sendRichMessageDraft(chatId, draftId, richMessage, Object.keys(other).length ? other : undefined);
}

export function createDraftStreamUpdater(
  api: BotContext["api"],
  chatId: number,
  draftId: number,
  messageThreadId: number | undefined,
  maxLen: number,
  onDraftError?: (err: unknown) => void,
  minEditIntervalMs = 700,
): StreamUpdater {
  const preview = createDraftPreviewModel(maxLen);
  let lastRendered = "";
  let lastEditAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let disabled = false;
  let pendingEdit: Promise<void> = Promise.resolve();
  let thinkingShown = false;

  const enqueue = (send: () => Promise<void>): void => {
    pendingEdit = pendingEdit.then(async () => {
      if (disposed || disabled) return;
      try {
        await send();
      } catch (error) {
        if (isMessageNotModifiedError(error)) return;
        disabled = true;
        try { onDraftError?.(error); } catch { /* keep preview failure isolated */ }
      }
    }).catch(() => {
      // Preserve the queue after a failed update.
    });
  };

  const showThinking = (): void => {
    if (disposed || disabled || thinkingShown) return;
    thinkingShown = true;
    lastRendered = "thinking";
    lastEditAt = Date.now();
    enqueue(() => callSendRichMessageDraft(api, chatId, draftId, buildRichThinkingMessage(), messageThreadId));
  };

  const render = (): void => {
    if (disposed || disabled) return;
    const result = preview.render();
    if (!result || result.renderKey === lastRendered) return;

    lastRendered = result.renderKey;
    lastEditAt = Date.now();
    enqueue(() => callSendRichMessageDraft(api, chatId, draftId, result.richMessage, messageThreadId));
  };

  const scheduleRender = (): void => {
    if (disposed || disabled) return;
    const wait = minEditIntervalMs - (Date.now() - lastEditAt);
    if (wait <= 0) {
      render();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, wait);
  };

  const dispose = (): void => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    onStart: showThinking,
    onTextDelta: (delta, fullText) => {
      preview.onTextDelta(delta, fullText);
      scheduleRender();
    },
    onToolStart: (toolName) => {
      preview.onToolStart(toolName);
      scheduleRender();
    },
    onToolError: () => {
      preview.onToolError();
      scheduleRender();
    },
    stopAndWait: async () => {
      dispose();
      await pendingEdit.catch(() => undefined);
    },
    dispose,
  };
}

export function createSilentStreamUpdater(): StreamUpdater {
  return {
    onStart: () => undefined,
    onTextDelta: () => undefined,
    onToolStart: () => undefined,
    onToolError: () => undefined,
    stopAndWait: async () => undefined,
    dispose: () => undefined,
  };
}

export function stripProtocolTags(text: string): string {
  return text
    .replace(/<\/?\s*tg-(?:attachment|reply|cron)\b[^>]*>/gi, "")
    .replace(/<\s*tg-(?:attachment|reply|cron)\b[^\r\n>]*/gi, "")
    .replace(/&lt;\/?\s*tg-(?:attachment|reply|cron)\b[\s\S]*?&gt;/gi, "");
}

function buildStreamingPreviewWithToolBlock(text: string, toolBlock: string, limit: number): string {
  const available = Math.max(32, limit - toolBlock.length);
  if (!text) return toolBlock.trim();
  if (text.length <= available) return `${toolBlock}${text}`;
  return `${toolBlock}…${text.slice(-available)}`;
}

export function buildStreamingPreview(text: string, tools: string[], limit: number): string {
  return buildStreamingPreviewWithToolBlock(text, tools.length ? `${tools.join("\n")}\n\n` : "", limit);
}

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let remaining = text;
  while (remaining) {
    if (remaining.length <= limit) {
      parts.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.3) cut = limit;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return parts;
}


export interface PreparedReply {
  body: string;
  attachments: TgAttachment[];
  warnings: string[];
  replyParameters?: ReplyParameters;
}

export interface CronPreparedReply {
  body: string;
  attachments: TgAttachment[];
  warnings: string[];
}

function prepareBody(text: string, tools: string[]): string {
  let body = stripProtocolTags(text);
  if (tools.length) body = `${tools.join("\n")}${body ? `\n\n${body}` : ""}`;
  return body.trim() || t("(无回复)");
}

export function prepareCronReply(text: string, tools: string[]): CronPreparedReply {
  const reply = extractTgReplyDirective(text || "");
  const attachments = extractTgAttachments(reply.text);
  return {
    body: prepareBody(attachments.text, tools),
    attachments: attachments.attachments,
    warnings: [...reply.warnings, ...attachments.warnings],
  };
}

export function prepareReply(
  context: BotContext,
  text: string,
  tools: string[],
  extraWarnings: string[] = [],
): PreparedReply {
  const reply = extractTgReplyDirective(text || "");
  const attachments = extractTgAttachments(reply.text);
  const resolved = resolveReplyParameters(replyScopeKey(context), reply.directive);
  return {
    body: prepareBody(attachments.text, tools),
    attachments: attachments.attachments,
    warnings: [...reply.warnings, ...attachments.warnings, ...resolved.warnings, ...extraWarnings],
    replyParameters: resolved.replyParameters,
  };
}

export async function sendPreparedReply(
  context: BotContext,
  prepared: PreparedReply,
  maxLength: number,
): Promise<void> {
  let first = true;
  if (prepared.body.trim()) {
    for (const part of splitMessage(prepared.body, maxLength)) {
      const other = first && prepared.replyParameters
        ? { reply_parameters: prepared.replyParameters }
        : undefined;
      const sent = await context.replyWithRichMessage(buildRichMessage(part), other);
      rememberReplyMessage(replyScopeKey(context), "self", sent.message_id, part);
      first = false;
    }
  }

  await sendAttachments(context, prepared.attachments, prepared.warnings, first ? prepared.replyParameters : undefined);
}

async function sendAttachments(
  context: BotContext,
  attachments: TgAttachment[],
  warnings: string[],
  replyParameters?: ReplyParameters,
): Promise<void> {
  if (warnings.length) {
    const preview = warnings.slice(0, 3).join("\n");
    const more = warnings.length > 3 ? `${t("\n... 还有 ")}${warnings.length - 3}${t(" 条")}` : "";
    await context.reply(`${t("⚠️ 附件解析告警：\n")}${preview}${more}`).catch(() => undefined);
  }

  let first = true;
  for (const attachment of attachments) {
    try {
      const other = first && replyParameters ? { reply_parameters: replyParameters } : undefined;
      await sendOneAttachment(context, attachment, other);
    } catch (error) {
      await context.reply(`${t("❌ 附件发送失败：")}${attachment.label || t("未知附件")}\n${(error as Error).message}`).catch(() => undefined);
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
type SendOther = { reply_parameters?: ReplyParameters };
type MediaInput = TgAttachment["media"];
type Sender = (context: BotContext, media: MediaInput, other?: SendOther) => Promise<unknown>;

const METHOD_BY_KIND: Record<TgAttachmentKind, ReplyMethodName> = {
  photo: "replyWithPhoto",
  document: "replyWithDocument",
  video: "replyWithVideo",
  audio: "replyWithAudio",
  animation: "replyWithAnimation",
  voice: "replyWithVoice",
  video_note: "replyWithVideoNote",
  sticker: "replyWithSticker",
};

const SENDERS: Record<ReplyMethodName, Sender> = {
  replyWithPhoto: (context, media, other) => context.replyWithPhoto(media, other),
  replyWithDocument: (context, media, other) => context.replyWithDocument(media, other),
  replyWithVideo: (context, media, other) => context.replyWithVideo(media, other),
  replyWithAudio: (context, media, other) => context.replyWithAudio(media, other),
  replyWithAnimation: (context, media, other) => context.replyWithAnimation(media, other),
  replyWithVoice: (context, media, other) => context.replyWithVoice(media, other),
  replyWithVideoNote: (context, media, other) => context.replyWithVideoNote(media, other),
  replyWithSticker: (context, media, other) => context.replyWithSticker(media, other),
};

export async function sendOneAttachment(context: BotContext, attachment: TgAttachment, other?: SendOther): Promise<void> {
  const method = METHOD_BY_KIND[attachment.kind] || "replyWithDocument";
  try {
    await SENDERS[method](context, attachment.media, other);
  } catch (error) {
    if (method === "replyWithDocument") throw error;
    await SENDERS.replyWithDocument(context, attachment.media, other);
  }
}

type TelegramApi = {
  sendPhoto: (...args: any[]) => Promise<unknown>;
  sendDocument: (...args: any[]) => Promise<unknown>;
  sendVideo: (...args: any[]) => Promise<unknown>;
  sendAudio: (...args: any[]) => Promise<unknown>;
  sendAnimation: (...args: any[]) => Promise<unknown>;
  sendVoice: (...args: any[]) => Promise<unknown>;
  sendVideoNote: (...args: any[]) => Promise<unknown>;
  sendSticker: (...args: any[]) => Promise<unknown>;
};

const API_SENDERS: Record<ReplyMethodName, (api: TelegramApi, chatId: number, media: MediaInput) => Promise<unknown>> = {
  replyWithPhoto: (api, chatId, media) => api.sendPhoto(chatId, media),
  replyWithDocument: (api, chatId, media) => api.sendDocument(chatId, media),
  replyWithVideo: (api, chatId, media) => api.sendVideo(chatId, media),
  replyWithAudio: (api, chatId, media) => api.sendAudio(chatId, media),
  replyWithAnimation: (api, chatId, media) => api.sendAnimation(chatId, media),
  replyWithVoice: (api, chatId, media) => api.sendVoice(chatId, media),
  replyWithVideoNote: (api, chatId, media) => api.sendVideoNote(chatId, media),
  replyWithSticker: (api, chatId, media) => api.sendSticker(chatId, media),
};

export async function sendAttachmentByApi(
  api: TelegramApi,
  chatId: number,
  attachment: TgAttachment,
): Promise<void> {
  const method = METHOD_BY_KIND[attachment.kind] || "replyWithDocument";
  try {
    await API_SENDERS[method](api, chatId, attachment.media);
  } catch (error) {
    if (method === "replyWithDocument") throw error;
    await API_SENDERS.replyWithDocument(api, chatId, attachment.media);
  }
}

export async function sendReply(
  context: BotContext,
  text: string,
  tools: string[],
  maxLength: number,
  warnings: string[] = [],
): Promise<void> {
  await sendPreparedReply(context, prepareReply(context, text, tools, warnings), maxLength);
}


export const CRON_HELP_TEXT = [
  t("⏰ /cron 用法"),
  t("- /cron（打开交互菜单）"),
  "- /cron list",
  "- /cron stat",
  t("- /cron add at <ISO时间> <内容>（可用 名称||内容 指定任务名）"),
  t("- /cron add every <间隔> <内容>（如 10m、2h、1d；可用 名称||内容）"),
  t("- /cron add cron \"<表达式>\" [时区] <内容>（可用 名称||内容）"),
  "- /cron on <id>",
  "- /cron off <id>",
  "- /cron del <id>",
  t("- /cron rename <id> <新名称>"),
  "- /cron run <id>",
].join("\n");

export function extractCommandArgs(text: string, command: string): string {
  const prefix = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
  return text.replace(prefix, "").trim();
}

export function splitCommandArgs(input: string): string[] {
  if (!input.trim()) return [];

  const args: string[] = [];
  const tokenRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    args.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return args;
}

export function parseNamedPrompt(input: string): { name?: string; prompt: string } {
  const raw = String(input || "").trim();
  if (!raw) return { prompt: "" };

  const separator = raw.indexOf("||");
  if (separator < 0) return { prompt: raw };

  const name = raw.slice(0, separator).trim();
  const prompt = raw.slice(separator + 2).trim();
  return prompt ? { name: name || undefined, prompt } : { prompt: raw };
}

const DURATION_UNITS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

export function parseDurationMs(input: string): number | undefined {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return undefined;

  const partRe = /(\d+)\s*(d|h|m|s)/g;
  let total = 0;
  let matched = "";
  let match: RegExpExecArray | null;
  while ((match = partRe.exec(value)) !== null) {
    const amount = Number.parseInt(match[1], 10);
    const multiplier = DURATION_UNITS[match[2]];
    if (!Number.isFinite(amount) || multiplier === undefined) return undefined;
    total += amount * multiplier;
    matched += match[0];
  }

  if (!matched || matched.replace(/\s+/g, "") !== value.replace(/\s+/g, "")) return undefined;
  return total >= 1000 ? total : undefined;
}

export function looksLikeTimezone(input: string): boolean {
  const value = String(input || "").trim();
  if (!value) return false;
  if (value === "UTC" || value === "GMT") return true;
  if (/^(UTC|GMT)[+-]\d{1,2}$/.test(value)) return true;
  return /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/.test(value);
}

export function formatDateTime(milliseconds?: number): string {
  if (!milliseconds || milliseconds <= 0) return "-";
  return new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
}

export function formatCompactDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1000));
  const parts: string[] = [];
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (remainder || !parts.length) parts.push(`${remainder}s`);
  return parts.join("");
}

export function formatCronSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at": return `at ${formatDateTime(schedule.atMs)}`;
    case "every": return `every ${formatCompactDuration(schedule.everyMs)}${t("（anchor=")}${formatDateTime(schedule.anchorMs)}${t("）")}`;
    case "cron": return `cron "${schedule.expr}" @${schedule.timezone}`;
    default: return "unknown";
  }
}

export function formatCronJobLine(job: CronJobRecord): string {
  const status = job.enabled ? "🟢" : "⚪";
  const running = job.state.runningRunId ? " ⏳running" : "";
  const lastStatus = job.state.lastStatus ? ` | last=${job.state.lastStatus}` : "";
  const lastError = job.state.lastError ? ` | err=${truncate(job.state.lastError, 40)}` : "";

  return [
    `${status} ${job.id}${running}`,
    `  ${truncate(job.name, 70)}`,
    `  ${formatCronSchedule(job.schedule)}`,
    `  next=${formatDateTime(job.state.nextRunAtMs)}${lastStatus}${lastError}`,
  ].join("\n");
}

export function formatCronStatus(status: SchedulerStatus): string {
  return [
    `${t("⏰ 定时服务：")}${status.enabled ? t("开启") : t("关闭")}`,
    `${t("总任务：")}${status.totalJobs}`,
    `${t("启用：")}${status.enabledJobs}`,
    `${t("运行中：")}${status.runningJobs}`,
    `${t("队列中：")}${status.queuedJobs}`,
    `${t("最近下次触发：")}${formatDateTime(status.nextRunAtMs)}`,
  ].join("\n");
}


export interface BotStatusSnapshot {
  alive: boolean;
  processing: boolean;
  providerLabel?: string;
  modelLabel: string;
  streamEnabled: boolean;
  thinkingLabel?: string;
  sessionLabel?: string;
  cost?: number;
  contextUsage?: PiSessionStats["contextUsage"];
  activeCount: number;
  cron: CronStatusSummary;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCost(cost: number): string {
  if (cost >= 1) return cost.toFixed(2);
  if (cost >= 0.01) return cost.toFixed(3);
  if (cost >= 0.001) return cost.toFixed(4);
  return cost.toPrecision(2);
}

export function formatContextUsage(
  usage?: PiSessionStats["contextUsage"],
): string | undefined {
  if (!usage || typeof usage.contextWindow !== "number") return undefined;

  const used = typeof usage.tokens === "number" ? formatInteger(usage.tokens) : "?";
  const total = formatInteger(usage.contextWindow);
  let percent = "";
  if (typeof usage.percent === "number") {
    const precision = usage.percent >= 10 || Number.isInteger(usage.percent) ? 0 : 1;
    percent = ` (${usage.percent.toFixed(precision)}%)`;
  }

  return `${t("📦 上下文占用: ")}${used} / ${total}${percent}`;
}

export function buildStatusLines(snapshot: BotStatusSnapshot): string[] {
  const lines: Array<string | undefined> = [
    `${snapshot.alive ? t("✅ 运行中") : t("💤 未启动")} | ${snapshot.processing ? t("⏳ 处理中") : t("🟢 空闲")}`,
    snapshot.providerLabel ? `${t("🏢 供应商: ")}${snapshot.providerLabel}` : undefined,
    `${t("🤖 模型: ")}${snapshot.modelLabel}`,
    `${t("⚙️ 输出: ")}${snapshot.streamEnabled ? t("流式") : t("非流式")}`,
    snapshot.thinkingLabel ? `${t("🧠 思考: ")}${snapshot.thinkingLabel}` : undefined,
    snapshot.sessionLabel ? `${t("🗂 会话: ")}${snapshot.sessionLabel}` : undefined,
    typeof snapshot.cost === "number" && snapshot.cost > 0 ? `${t("💰 花费: $")}${formatCost(snapshot.cost)}` : undefined,
    formatContextUsage(snapshot.contextUsage),
    `${t("📊 活跃: ")}${snapshot.activeCount}`,
    `${t("⏰ 定时: ")}${snapshot.cron.enabled ? t("开启") : t("关闭")}${t(" | 任务 ")}${snapshot.cron.totalJobs}${t("（启用 ")}${snapshot.cron.enabledJobs}${t("）")}`,
  ];

  return lines.filter((line): line is string => Boolean(line));
}


export interface AiToolDefinition {
  name: string;
  instructions: string;
}

export class AiToolRegistry {
  private readonly tools: AiToolDefinition[] = [];

  register(tool: AiToolDefinition): this {
    this.tools.push(tool);
    return this;
  }

  renderInstructions(): string {
    if (!this.tools.length) return "";
    const blocks = this.tools.map((tool, i) => `${t("# 工具 ")}${i + 1}: ${tool.name}\n${tool.instructions}`);
    return [
      t("你可以使用以下桥接工具协议。仅当确实需要时使用。"),
      ...blocks,
      t("如果无需调用工具，直接正常回答。"),
    ].join("\n\n");
  }
}

function telegramAttachmentTool(): AiToolDefinition {
  return {
  name: "tg-attachment",
  instructions: [
    t("当你需要让 Telegram 发送附件/媒体时，在回复中输出 <tg-attachment> 标签。"),
    t("支持来源：file_id、URL、本地路径 path、上传内容（encoding=base64|text）。"),
    t("支持类型 as：photo | document | video | audio | animation | voice | video_note | sticker。"),
    t("不要把标签包在 markdown 代码块里。"),
    t("URL/file_id/path 可用自闭合标签。"),
    t("上传内容用成对标签，建议带 filename。"),
    t("本地路径是指运行 Pi-Telegram 的服务器本机路径，不是用户手机路径。"),
    t("示例1（file_id）：<tg-attachment as=\"photo\" file_id=\"AgAC...\" />"),
    t("示例2（URL）：<tg-attachment as=\"document\" url=\"https://example.com/a.pdf\" />"),
    t("示例3（本地路径）：<tg-attachment as=\"document\" path=\"C:/data/report.pdf\" />"),
    t("示例4（上传文本）：<tg-attachment as=\"document\" filename=\"note.txt\" encoding=\"text\">hello</tg-attachment>"),
    t("示例5（上传二进制）：<tg-attachment as=\"video\" filename=\"clip.mp4\" encoding=\"base64\">...</tg-attachment>"),
  ].join("\n"),
  };
}

function telegramReplyTool(): AiToolDefinition {
  return {
  name: "tg-reply",
  instructions: [
    t("当你要针对某条历史消息（可来自用户或你自己）进行回复时，输出 <tg-reply ... /> 标签。"),
    t("你可以回复整条消息，也可以只引用其中一段（quote）。"),
    t("常用属性："),
    t("- from: any | user | self（默认 any）"),
    t("- contains: 用于定位目标消息（目标消息文本需包含这段）"),
    t("- quote: 需要引用的子串（可选，不填则可只按消息回复）"),
    t("- message_id: 直接按消息 ID 回复（可选，优先级高）"),
    t("示例1：<tg-reply from=\"user\" contains=\"这个方案不安全\" quote=\"不安全\" />"),
    t("示例2：<tg-reply from=\"self\" contains=\"我上一条的结论\" />"),
    t("示例3：<tg-reply message_id=\"1234\" quote=\"关键段落\" />"),
    t("tg-reply 标签可与正文、tg-attachment 同时出现。"),
  ].join("\n"),
  };
}

function telegramCronTool(): AiToolDefinition {
  return {
  name: "tg-cron",
  instructions: [
    t("当你需要管理 Telegram 聊天内的定时任务时，输出 <tg-cron ... /> 标签。"),
    t("支持 action: add | list | stat | on | off | del | run | rename。"),
    t("add 需要 kind: at | every | cron。"),
    t("add(kind=at) 必填 at（ISO 时间）和 prompt（任务内容，可放在标签体）。"),
    t("add(kind=every) 必填 every（如 10m/2h/1d）和 prompt。"),
    t("add(kind=cron) 必填 expr（cron 表达式）和 prompt，可选 timezone。"),
    t("on/off/del/run 需要 id。"),
    t("rename 需要 id 和 name（或标签体作为名称）。"),
    t("不要把标签包在 markdown 代码块里。"),
    t("示例1：<tg-cron action=\"add\" kind=\"every\" every=\"30m\" prompt=\"检查报警并总结\" />"),
    t("示例2：<tg-cron action=\"add\" kind=\"cron\" expr=\"0 9 * * 1-5\" timezone=\"Asia/Shanghai\" prompt=\"工作日早报\" />"),
    t("示例3：<tg-cron action=\"list\" />"),
    t("示例4：<tg-cron action=\"off\" id=\"abcd1234\" />"),
    t("示例5：<tg-cron action=\"rename\" id=\"abcd1234\" name=\"工作日早报\" />"),
  ].join("\n"),
  };
}

function buildToolRegistry(): AiToolRegistry {
  return new AiToolRegistry()
    .register(telegramReplyTool())
    .register(telegramAttachmentTool())
    .register(telegramCronTool());
}

export function getRegisteredToolSystemPrompt(): string {
  return buildToolRegistry().renderInstructions();
}
