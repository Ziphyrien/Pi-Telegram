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
import { hydrateFiles } from "@grammyjs/files";
import { CommandGroup } from "@grammyjs/commands";
import { Menu } from "@grammyjs/menu";
import { autoChatAction, type AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { log } from "./log.js";
import { mdToPlainText, mdToTgHtml } from "./md2tg.js";
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
import {
  extractTgCronDirectives,
  type TgCronDirective,
} from "./cron-tool.js";
import type { PiPool } from "./pool.js";
import type { CronJobRecord, CronSchedule } from "./cron-types.js";
import type { CronService } from "./cron-service.js";
import type { BotConfig, PiImage } from "./types.js";

type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export interface CreateBotOptions {
  botIndex: number;
  config: BotConfig;
  pool: PiPool;
  cron: CronService;
  maxResponseLength: number;
  initialStreamByChat?: Record<string, boolean>;
  onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;
}

export function createBot(opts: CreateBotOptions): Bot<BotContext> {
  const {
    botIndex,
    config,
    pool,
    cron,
    maxResponseLength,
    initialStreamByChat,
    onStreamModeChange,
  } = opts;
  const bot = new Bot<BotContext>(config.token);
  const botKey = createHash("sha1").update(config.token).digest("hex").slice(0, 12);

  // --- plugins ---
  bot.api.config.use(hydrateFiles(config.token));
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

    const cronSt = cron.status(chatId);

    const lines = [
      `${alive} | ${state}`,
      providerLabel ? `🏢 供应商: ${providerLabel}` : "",
      `🤖 模型: ${modelLabel}`,
      `⚙️ 输出: ${menus.isStreamEnabled(chatId) ? "流式" : "非流式"}`,
      thinkingLabel ? `🧠 思考: ${thinkingLabel}` : "",
      sessionLabel ? `🗂 会话: ${sessionLabel}` : "",
      costLabel,
      `📊 活跃: ${pool.size}`,
      `⏰ 定时: ${cronSt.enabled ? "开启" : "关闭"} | 任务 ${cronSt.totalJobs}（启用 ${cronSt.enabledJobs}）`,
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
    if (inst?.alive && inst.running) {
      const queued = inst.queuedCount;
      inst.abort();
      await tgCtx.reply(
        queued > 0
          ? `🛑 已中止当前任务（队列保留 ${queued} 条）\n如需清空队列可用 /abortall`
          : "🛑 已中止当前任务",
      );
    } else if (inst?.alive && inst.queuedCount > 0) {
      // 理论上不会进入（queued>0 时 running 应为 true），保底处理。
      const queued = inst.queuedCount;
      inst.abortAll();
      await tgCtx.reply(`🛑 已取消队列 ${queued} 条`);
    } else {
      await tgCtx.reply("当前无操作");
    }
  });

  commandGroup.command("abortall", "中止并清空队列", async (tgCtx) => {
    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.has(key);
    if (inst?.alive && inst.busy) {
      const queued = inst.queuedCount;
      inst.abortAll();
      await tgCtx.reply(
        queued > 0
          ? `🛑 已中止当前任务，并清空队列 ${queued} 条`
          : "🛑 已中止当前任务",
      );
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

  let cronScopeBotId: number | null = null;
  const getCronReplyScope = async (chatId: number): Promise<string> => {
    if (cronScopeBotId == null) {
      const me = await bot.api.getMe();
      cronScopeBotId = me.id;
    }
    return `${cronScopeBotId}:${chatId}`;
  };

  const sendCronAttachment = async (chatId: number, att: TgAttachment): Promise<void> => {
    const api = bot.api;
    const kind = REPLY_BY_KIND[att.kind] || "replyWithDocument";

    try {
      switch (kind) {
        case "replyWithPhoto":
          await api.sendPhoto(chatId, att.media as any);
          return;
        case "replyWithDocument":
          await api.sendDocument(chatId, att.media as any);
          return;
        case "replyWithVideo":
          await api.sendVideo(chatId, att.media as any);
          return;
        case "replyWithAudio":
          await api.sendAudio(chatId, att.media as any);
          return;
        case "replyWithAnimation":
          await api.sendAnimation(chatId, att.media as any);
          return;
        case "replyWithVoice":
          await api.sendVoice(chatId, att.media as any);
          return;
        case "replyWithVideoNote":
          await api.sendVideoNote(chatId, att.media as any);
          return;
        case "replyWithSticker":
          await api.sendSticker(chatId, att.media as any);
          return;
        default:
          await api.sendDocument(chatId, att.media as any);
      }
    } catch (err) {
      if (kind === "replyWithDocument") throw err;
      await api.sendDocument(chatId, att.media as any);
    }
  };

  const sendCronReply = async (chatId: number, text: string, tools: string[]): Promise<void> => {
    const prepared = prepareCronReply(text, tools);
    const scope = await getCronReplyScope(chatId);

    if (prepared.warnings.length) {
      const preview = prepared.warnings.slice(0, 3).join("\n");
      const more = prepared.warnings.length > 3 ? `\n... 还有 ${prepared.warnings.length - 3} 条` : "";
      await bot.api.sendMessage(chatId, `⚠️ 附件解析告警：\n${preview}${more}`).catch(() => {});
    }

    if (prepared.body.trim()) {
      for (const part of splitMessage(prepared.body, maxResponseLength)) {
        const html = mdToTgHtml(part);
        try {
          const sent = await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
          rememberReplyMessage(scope, "self", sent.message_id, part);
        } catch (err) {
          log.warn(`chat${chatId} 定时任务 HTML 发送失败，降级纯文本：${describeTelegramSendError(err)}`);
          const plain = mdToPlainText(stripProtocolTags(part));
          const sent = await bot.api.sendMessage(chatId, plain);
          rememberReplyMessage(scope, "self", sent.message_id, plain);
        }
      }
    }

    for (const att of prepared.attachments) {
      try {
        await sendCronAttachment(chatId, att);
      } catch (err) {
        await bot.api.sendMessage(chatId, `❌ 附件发送失败：${att.label || "未知附件"}\n${(err as Error).message}`).catch(() => {});
      }
    }
  };

  cron.setExecutor(async ({ job }) => {
    const key = chatKey(botKey, job.chatId);
    const inst = pool.get(key);

    try {
      const result = await inst.prompt(job.prompt);
      await sendCronReply(job.chatId, result.text, result.tools);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await bot.api.sendMessage(
        job.chatId,
        `❌ 定时任务「${job.name || job.id}」执行失败：${truncate(message, 1500)}`,
      ).catch(() => {});
      return { ok: false, error: message };
    }
  });

  type CronPendingInput =
    | { kind: "at" | "every" | "cron"; startedAt: number }
    | { kind: "rename"; jobId: string; startedAt: number };
  const cronPendingInput = new Map<number, CronPendingInput>();
  const cronMenuPageByChat = new Map<number, number>();
  const cronMenuMessageByChat = new Map<number, number>();
  const cronRootMenuId = `cron-menu-${botIndex}`;
  const CRON_MENU_PAGE_SIZE = 6;

  const buildCronMenuTitle = (chatId: number): string => {
    const pending = cronPendingInput.get(chatId);
    const hint = pending
      ? `\n当前等待输入：${pending.kind}（请直接发送文本，或在菜单中取消）`
      : "";
    return `⏰ 定时任务菜单${hint}`;
  };

  const setCronMenuPage = (chatId: number, page: number, totalPages: number): number => {
    const safeTotal = Math.max(1, totalPages);
    const next = Math.max(0, Math.min(page, safeTotal - 1));
    cronMenuPageByChat.set(chatId, next);
    return next;
  };

  const upsertCronMenuMessage = async (tgCtx: BotContext): Promise<void> => {
    const chatId = tgCtx.chat?.id ?? 0;
    const text = buildCronMenuTitle(chatId);
    const existingId = cronMenuMessageByChat.get(chatId);

    await ensureCronMenuReady(tgCtx);

    if (existingId) {
      try {
        await tgCtx.api.editMessageText(chatId, existingId, text, { reply_markup: cronMenu });
        return;
      } catch (err) {
        if (isMessageNotModifiedError(err)) return;
        cronMenuMessageByChat.delete(chatId);
        log.warn(`chat${chatId} 更新 /cron 菜单失败，将尝试重新发送：${describeTelegramSendError(err)}`);
      }
    }

    const sent = await tgCtx.reply(text, { reply_markup: cronMenu });
    cronMenuMessageByChat.set(chatId, sent.message_id);
  };

  const cronMenu = new Menu<BotContext>(cronRootMenuId, {
    onMenuOutdated: "菜单已更新，请重试",
    fingerprint: (ctx) => {
      const chatId = ctx.chat?.id ?? 0;
      const st = cron.status(chatId);
      const pending = cronPendingInput.get(chatId);
      const page = cronMenuPageByChat.get(chatId) ?? 0;
      const jobs = cron.list(chatId)
        .slice(0, 60)
        .map((x) => `${x.id}:${x.enabled ? 1 : 0}:${x.updatedAtMs}:${x.state.runningRunId ? 1 : 0}`)
        .join(",");
      return [
        `enabled:${st.enabled ? 1 : 0}`,
        `total:${st.totalJobs}`,
        `queued:${st.queuedJobs}`,
        `running:${st.runningJobs}`,
        `pending:${pending?.kind ?? ""}`,
        `page:${page}`,
        jobs,
      ].join("|");
    },
  }).dynamic((ctx, range) => {
    const chatId = ctx.chat?.id ?? 0;
    const menuMessageId = Number((ctx.msg as any)?.message_id);
    if (Number.isSafeInteger(menuMessageId) && menuMessageId > 0) {
      cronMenuMessageByChat.set(chatId, menuMessageId);
    }
    const st = cron.status(chatId);
    const jobs = cron.list(chatId);
    const pending = cronPendingInput.get(chatId);

    const totalPages = Math.max(1, Math.ceil(jobs.length / CRON_MENU_PAGE_SIZE));
    const rawPage = cronMenuPageByChat.get(chatId) ?? 0;
    const page = setCronMenuPage(chatId, rawPage, totalPages);
    const start = page * CRON_MENU_PAGE_SIZE;
    const pageJobs = jobs.slice(start, start + CRON_MENU_PAGE_SIZE);

    range.text(
      `📊 ${st.enabled ? "开启" : "关闭"} | 任务 ${st.totalJobs} | 运行 ${st.runningJobs} | 队列 ${st.queuedJobs}`,
      (ctx) => ctx.answerCallbackQuery({ text: "状态已更新" }),
    ).row();

    range.text("🔄 刷新", async (ctx) => {
      try { ctx.menu.update(); } catch { /* ignore */ }
      await ctx.answerCallbackQuery({ text: "已刷新" });
    });

    range.text("➕ 一次性", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "at", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "请发送: <ISO时间> <内容>" });
      await ctx.reply("🕒 请输入一次性任务：\n<ISO时间> <内容>\n可选名称：<ISO时间> <名称||内容>\n例如：2026-03-01T09:00:00+08:00 早报总结");
      try { ctx.menu.update(); } catch { /* ignore */ }
    }).row();

    range.text("➕ 间隔", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "every", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "请发送: <间隔> <内容>" });
      await ctx.reply("⏱ 请输入间隔任务：\n<间隔> <内容>\n可选名称：<间隔> <名称||内容>\n例如：10m 检查报警\n支持：s/m/h/d");
      try { ctx.menu.update(); } catch { /* ignore */ }
    });

    range.text("➕ Cron", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "cron", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: "请发送: <表达式> | [时区] | [名称] | <内容>" });
      await ctx.reply("🧩 请输入 Cron 任务：\n<表达式> | [时区] | [名称] | <内容>\n例如：0 9 * * 1-5 | Asia/Shanghai | 工作日早报 | 汇总日报");
      try { ctx.menu.update(); } catch { /* ignore */ }
    }).row();

    if (pending) {
      const ageSec = Math.max(0, Math.floor((Date.now() - pending.startedAt) / 1000));
      range.text(`❌ 取消输入（${pending.kind}, ${ageSec}s）`, async (ctx) => {
        cronPendingInput.delete(chatId);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: "已取消" });
      }).row();
    }

    if (!jobs.length) {
      range.text("当前无任务", (ctx) => ctx.answerCallbackQuery({ text: "暂无任务" }));
      return;
    }

    range.text(`📄 第 ${page + 1}/${totalPages} 页`, (ctx) =>
      ctx.answerCallbackQuery({ text: `本页 ${pageJobs.length} 条` }),
    ).row();

    for (const job of pageJobs) {
      const icon = job.enabled ? "🟢" : "⚪";
      const running = job.state.runningRunId ? " ⏳" : "";
      range.text(`${icon}${running} ${truncate(job.name, 18)} [${job.id}]`, (ctx) =>
        ctx.answerCallbackQuery({ text: `${formatCronSchedule(job.schedule)} | next=${formatDateTime(job.state.nextRunAtMs)}`.slice(0, 190) }),
      ).row();

      range.text(job.enabled ? "⏸ 停用" : "▶️ 启用", async (ctx) => {
        await cron.setEnabled(job.id, !job.enabled);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: job.enabled ? "已停用" : "已启用" });
      });

      range.text("▶️ 执行", async (ctx) => {
        const ok = await cron.runNow(job.id);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: ok ? "已加入执行队列" : "加入失败" });
      });

      range.text("✏️ 改名", async (ctx) => {
        cronPendingInput.set(chatId, { kind: "rename", jobId: job.id, startedAt: Date.now() });
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: "请发送新名称" });
        await ctx.reply(`✏️ 请发送任务 ${job.id} 的新名称`);
      }).row();

      range.text("🗑 删除", async (ctx) => {
        await cron.remove(job.id);
        const nextTotalPages = Math.max(1, Math.ceil(Math.max(0, jobs.length - 1) / CRON_MENU_PAGE_SIZE));
        setCronMenuPage(chatId, page, nextTotalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: "已删除" });
      }).row();
    }

    if (totalPages > 1) {
      range.text("⬅️ 上一页", async (ctx) => {
        setCronMenuPage(chatId, page - 1, totalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: `第 ${Math.max(1, page)} 页` });
      });

      range.text("➡️ 下一页", async (ctx) => {
        setCronMenuPage(chatId, page + 1, totalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: `第 ${Math.min(totalPages, page + 2)} 页` });
      }).row();
    }
  });

  bot.use(cronMenu);

  const ensureCronMenuReady = async (tgCtx: BotContext): Promise<void> => {
    await cronMenu.middleware()(tgCtx, async () => {});
  };

  commandGroup.command("cron", "管理定时任务", async (tgCtx) => {
    try {
      const raw = extractCommandArgs(String((tgCtx.message as any)?.text || ""), "cron");
      const chatId = tgCtx.chat.id;

      if (!raw.trim()) {
        await upsertCronMenuMessage(tgCtx);
        return;
      }

      const args = splitCommandArgs(raw);
      const sub = (args.shift() || "help").toLowerCase();

    if (sub === "help" || sub === "h" || sub === "?") {
      await tgCtx.reply(CRON_HELP_TEXT);
      return;
    }

    if (sub === "list" || sub === "ls") {
      const jobs = cron.list(chatId);
      if (!jobs.length) {
        await tgCtx.reply("当前聊天暂无定时任务。使用 /cron add ... 创建。");
        return;
      }

      const lines = jobs.map((job) => formatCronJobLine(job));
      const text = `⏰ 定时任务（${jobs.length}）\n${lines.join("\n")}`;
      for (const part of splitMessage(text, maxResponseLength)) {
        await tgCtx.reply(part);
      }
      return;
    }

    if (sub === "stat" || sub === "status") {
      const st = cron.status(chatId);
      await tgCtx.reply(formatCronStatus(st));
      return;
    }

    if (sub === "add") {
      const kind = (args.shift() || "").toLowerCase();
      if (!kind) {
        await tgCtx.reply("用法：/cron add at|every|cron ...");
        return;
      }

      if (kind === "at") {
        const atRaw = args.shift() || "";
        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        if (!atRaw || !prompt) {
          await tgCtx.reply("用法：/cron add at <ISO时间> <内容>");
          return;
        }

        const atMs = new Date(atRaw).getTime();
        if (!Number.isFinite(atMs)) {
          await tgCtx.reply("时间格式非法，请使用 ISO 8601，例如 2026-03-01T09:00:00+08:00");
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "at", atMs },
        });
        await tgCtx.reply(`✅ 已创建任务 ${job.id}\n${formatCronSchedule(job.schedule)}\n名称：${job.name}`);
        return;
      }

      if (kind === "every") {
        const everyRaw = args.shift() || "";
        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        const everyMs = parseDurationMs(everyRaw);
        if (!everyMs || !prompt) {
          await tgCtx.reply("用法：/cron add every <间隔> <内容>\n示例：/cron add every 10m 早报总结");
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() },
        });
        await tgCtx.reply(`✅ 已创建任务 ${job.id}\n${formatCronSchedule(job.schedule)}\n名称：${job.name}`);
        return;
      }

      if (kind === "cron") {
        const expr = args.shift() || "";
        if (!expr) {
          await tgCtx.reply("用法：/cron add cron \"<表达式>\" [时区] <内容>");
          return;
        }

        let timezone = cron.getDefaultTimezone();
        if (args.length >= 2 && looksLikeTimezone(args[0])) {
          timezone = args.shift()!;
        }

        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        if (!prompt) {
          await tgCtx.reply("用法：/cron add cron \"<表达式>\" [时区] <内容>");
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "cron", expr, timezone },
        });

        await tgCtx.reply(`✅ 已创建任务 ${job.id}\n${formatCronSchedule(job.schedule)}\n名称：${job.name}`);
        return;
      }

      await tgCtx.reply("不支持的类型，仅支持 at / every / cron");
      return;
    }

    if (sub === "on" || sub === "off") {
      const id = (args.shift() || "").trim();
      if (!id) {
        await tgCtx.reply("用法：/cron on <id> 或 /cron off <id>");
        return;
      }
      const updated = await cron.setEnabled(id, sub === "on");
      if (!updated || updated.chatId !== chatId) {
        await tgCtx.reply("未找到该任务（或不属于当前聊天）");
        return;
      }
      await tgCtx.reply(`✅ 任务 ${id} 已${sub === "on" ? "启用" : "停用"}`);
      return;
    }

    if (sub === "del" || sub === "rm" || sub === "remove") {
      const id = (args.shift() || "").trim();
      if (!id) {
        await tgCtx.reply("用法：/cron del <id>");
        return;
      }
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        await tgCtx.reply("未找到该任务（或不属于当前聊天）");
        return;
      }
      await cron.remove(id);
      await tgCtx.reply(`🗑 已删除任务 ${id}`);
      return;
    }

    if (sub === "rename" || sub === "name") {
      const id = (args.shift() || "").trim();
      const newName = args.join(" ").trim();
      if (!id || !newName) {
        await tgCtx.reply("用法：/cron rename <id> <新名称>");
        return;
      }
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        await tgCtx.reply("未找到该任务（或不属于当前聊天）");
        return;
      }
      const updated = await cron.rename(id, newName);
      if (!updated) {
        await tgCtx.reply("重命名失败");
        return;
      }
      await tgCtx.reply(`✏️ 任务 ${id} 已重命名为：${updated.name}`);
      return;
    }

    if (sub === "run") {
      const id = (args.shift() || "").trim();
      if (!id) {
        await tgCtx.reply("用法：/cron run <id>");
        return;
      }
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        await tgCtx.reply("未找到该任务（或不属于当前聊天）");
        return;
      }
      const ok = await cron.runNow(id);
      await tgCtx.reply(ok ? `▶️ 任务 ${id} 已加入执行队列` : "加入队列失败");
      return;
    }

      await tgCtx.reply("未知子命令。发送 /cron help 查看用法。");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await tgCtx.reply(`❌ cron 操作失败：${truncate(message, 1000)}`).catch(() => {});
    }
  });

  type PromptPayload = { message: string; images?: PiImage[] };
  type PromptBuildOptions = { supportsImages: boolean };

  const imageSupportCache = new Map<number, { value: boolean; at: number }>();
  const draftCounterByChat = new Map<number, number>();

  function nextDraftId(chatId: number): number {
    const prev = draftCounterByChat.get(chatId) ?? 0;
    // Keep draft_id in a safe positive 31-bit range.
    const next = prev >= 2_000_000_000 ? 1 : prev + 1;
    draftCounterByChat.set(chatId, next);
    return next;
  }

  function getMessageThreadId(tgCtx: BotContext): number | undefined {
    const raw = Number((tgCtx.message as any)?.message_thread_id);
    if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
    return raw;
  }

  function shouldUseDraftStreaming(tgCtx: BotContext): boolean {
    const chat = tgCtx.chat as any;
    if (!chat) return false;
    // Bot API currently supports draft streaming for private chats.
    return chat.type === "private";
  }

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

  const executeCronDirectiveForChat = async (
    chatId: number,
    directive: TgCronDirective,
  ): Promise<{ notices: string[]; warnings: string[] }> => {
    const notices: string[] = [];
    const warnings: string[] = [];

    const ensureOwned = (id: string): CronJobRecord => {
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        throw new Error("未找到该任务（或不属于当前聊天）");
      }
      return job;
    };

    switch (directive.action) {
      case "list": {
        const jobs = cron.list(chatId);
        if (!jobs.length) {
          notices.push("⏰ 当前聊天暂无定时任务。");
          break;
        }
        notices.push(`⏰ 定时任务（${jobs.length}）\n${jobs.map((x) => formatCronJobLine(x)).join("\n")}`);
        break;
      }

      case "stat": {
        notices.push(formatCronStatus(cron.status(chatId)));
        break;
      }

      case "add": {
        const prompt = String(directive.prompt || "").trim();
        if (!prompt) throw new Error("add 缺少任务内容");

        const kind = directive.kind;
        if (!kind) throw new Error("add 缺少 kind");

        let schedule: CronSchedule;

        if (kind === "at") {
          const atRaw = String(directive.at || "").trim();
          const atMs = new Date(atRaw).getTime();
          if (!Number.isFinite(atMs)) {
            throw new Error("add kind=at 的 at 时间非法（需 ISO 时间）");
          }
          schedule = { kind: "at", atMs };
        } else if (kind === "every") {
          const everyMs = parseDurationMs(String(directive.every || "").trim());
          if (!everyMs) {
            throw new Error("add kind=every 的 every 非法（如 10m/2h/1d）");
          }
          schedule = { kind: "every", everyMs, anchorMs: Date.now() };
        } else {
          const expr = String(directive.expr || "").trim();
          if (!expr) throw new Error("add kind=cron 缺少 expr");

          const tzRaw = String(directive.timezone || "").trim();
          const timezone = tzRaw || cron.getDefaultTimezone();
          if (!looksLikeTimezone(timezone)) {
            throw new Error(`timezone 非法：${timezone}`);
          }
          schedule = { kind: "cron", expr, timezone };
        }

        const created = await cron.create({
          chatId,
          name: directive.name,
          prompt,
          schedule,
        });

        notices.push(`✅ 已创建任务 ${created.id}\n${formatCronSchedule(created.schedule)}\n名称：${created.name}`);
        break;
      }

      case "on": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error("on 缺少 id");
        ensureOwned(id);
        await cron.setEnabled(id, true);
        notices.push(`✅ 任务 ${id} 已启用`);
        break;
      }

      case "off": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error("off 缺少 id");
        ensureOwned(id);
        await cron.setEnabled(id, false);
        notices.push(`✅ 任务 ${id} 已停用`);
        break;
      }

      case "del": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error("del 缺少 id");
        ensureOwned(id);
        await cron.remove(id);
        notices.push(`🗑 已删除任务 ${id}`);
        break;
      }

      case "rename": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error("rename 缺少 id");
        ensureOwned(id);

        const newName = String(directive.name || "").trim();
        if (!newName) throw new Error("rename 缺少 name");

        const updated = await cron.rename(id, newName);
        if (!updated) throw new Error("rename 失败");

        notices.push(`✏️ 任务 ${id} 已重命名为：${updated.name}`);
        break;
      }

      case "run": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error("run 缺少 id");
        ensureOwned(id);
        const ok = await cron.runNow(id);
        notices.push(ok ? `▶️ 任务 ${id} 已加入执行队列` : `❌ 任务 ${id} 加入队列失败`);
        break;
      }

      default:
        warnings.push(`不支持的 tg-cron action: ${(directive as any).action}`);
        break;
    }

    return { notices, warnings };
  };

  const applyCronToolDirectives = async (
    tgCtx: BotContext,
    text: string,
  ): Promise<{ text: string; warnings: string[] }> => {
    const extracted = extractTgCronDirectives(text || "");
    const warnings = [...extracted.warnings];
    const notices: string[] = [];
    const chatId = tgCtx.chat?.id ?? 0;

    for (const directive of extracted.directives) {
      try {
        const res = await executeCronDirectiveForChat(chatId, directive);
        notices.push(...res.notices);
        warnings.push(...res.warnings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`tg-cron(${directive.action}) 执行失败：${message}`);
      }
    }

    const mergedText = [extracted.text.trim(), ...notices].filter(Boolean).join("\n\n");
    return { text: mergedText, warnings };
  };

  const consumePendingCronInput = async (
    tgCtx: BotContext,
    pending: CronPendingInput,
    text: string,
  ): Promise<boolean> => {
    const chatId = tgCtx.chat?.id ?? 0;
    const raw = String(text || "").trim();
    if (!raw) return true;

    try {
      if (pending.kind === "rename") {
        const job = cron.get(pending.jobId);
        if (!job || job.chatId !== chatId) {
          cronPendingInput.delete(chatId);
          await tgCtx.reply("❌ 目标任务不存在或不属于当前聊天");
          return true;
        }

        const updated = await cron.rename(pending.jobId, raw);
        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(tgCtx);
        if (!updated) {
          await tgCtx.reply("❌ 重命名失败");
          return true;
        }

        await tgCtx.reply(`✏️ 任务 ${updated.id} 已重命名为：${updated.name}`);
        return true;
      }

      if (pending.kind === "at") {
        const firstSpace = raw.indexOf(" ");
        if (firstSpace < 0) {
          await tgCtx.reply("❌ 格式不对，请发送：<ISO时间> <内容>");
          return true;
        }

        const atRaw = raw.slice(0, firstSpace).trim();
        const named = parseNamedPrompt(raw.slice(firstSpace + 1));
        const prompt = named.prompt;
        const atMs = new Date(atRaw).getTime();

        if (!Number.isFinite(atMs) || !prompt) {
          await tgCtx.reply("❌ 格式不对，请发送：<ISO时间> <内容>");
          return true;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "at", atMs },
        });

        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(tgCtx);
        await tgCtx.reply(`✅ 已创建任务 ${job.id}\n${formatCronSchedule(job.schedule)}\n名称：${job.name}`);
        return true;
      }

      if (pending.kind === "every") {
        const firstSpace = raw.indexOf(" ");
        if (firstSpace < 0) {
          await tgCtx.reply("❌ 格式不对，请发送：<间隔> <内容>，例如：10m 检查报警");
          return true;
        }

        const everyRaw = raw.slice(0, firstSpace).trim();
        const named = parseNamedPrompt(raw.slice(firstSpace + 1));
        const prompt = named.prompt;
        const everyMs = parseDurationMs(everyRaw);

        if (!everyMs || !prompt) {
          await tgCtx.reply("❌ 间隔格式非法，支持：s/m/h/d（如 30s、10m、2h、1d）");
          return true;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() },
        });

        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(tgCtx);
        await tgCtx.reply(`✅ 已创建任务 ${job.id}\n${formatCronSchedule(job.schedule)}\n名称：${job.name}`);
        return true;
      }

      // pending.kind === "cron"
      const parts = raw.split("|").map((x) => x.trim()).filter(Boolean);
      if (parts.length < 2) {
        await tgCtx.reply("❌ 格式不对，请发送：<表达式> | [时区] | [名称] | <内容>");
        return true;
      }

      const expr = parts[0];
      let timezone = cron.getDefaultTimezone();
      let name: string | undefined;
      let prompt = "";

      if (parts.length >= 4) {
        timezone = parts[1];
        name = parts[2] || undefined;
        prompt = parts.slice(3).join(" | ").trim();
      } else if (parts.length === 3) {
        timezone = parts[1];
        const named = parseNamedPrompt(parts[2]);
        name = named.name;
        prompt = named.prompt;
      } else {
        const named = parseNamedPrompt(parts[1]);
        name = named.name;
        prompt = named.prompt;
      }

      if (!prompt) {
        await tgCtx.reply("❌ 缺少任务内容，请发送：<表达式> | [时区] | [名称] | <内容>");
        return true;
      }

      if (!looksLikeTimezone(timezone)) {
        await tgCtx.reply(`❌ 时区格式非法：${timezone}`);
        return true;
      }

      const job = await cron.create({
        chatId,
        name,
        prompt,
        schedule: { kind: "cron", expr, timezone },
      });

      cronPendingInput.delete(chatId);
      await upsertCronMenuMessage(tgCtx);
      await tgCtx.reply(`✅ 已创建任务 ${job.id}\n${formatCronSchedule(job.schedule)}\n名称：${job.name}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await tgCtx.reply(`❌ 创建任务失败：${truncate(message, 800)}\n可继续输入，或打开 /cron 菜单取消`).catch(() => {});
      return true;
    }
  };

  const runPromptRequest = async (
    tgCtx: BotContext,
    inst: ReturnType<PiPool["get"]>,
    makePayload: (opts: PromptBuildOptions) => Promise<PromptPayload>,
  ): Promise<void> => {
    const ahead = inst.queuedCount + (inst.running ? 1 : 0);
    const chatId = tgCtx.chat?.id ?? 0;
    const useStream = menus.isStreamEnabled(chatId);
    const useDraftStream = useStream && shouldUseDraftStreaming(tgCtx);

    const initialStatus = ahead > 0
      ? `⏳ 排队中（前方 ${ahead} 条）...`
      : "⏳ 思考中...";
    const status = !useStream
      ? await tgCtx.reply(initialStatus)
      : null;

    let streamedText = "";
    tgCtx.chatAction = "typing";

    const onStart = ahead > 0
      ? () => {
        if (!status) return;
        void status.editText("⏳ 思考中...").catch(() => {});
      }
      : undefined;

    try {
      const supportsImages = await supportsImagesForChat(chatId, inst);
      const { message, images } = await makePayload({ supportsImages });
      const promptMessage = message;

      if (useStream) {
        const stream = useDraftStream
          ? createDraftStreamUpdater(
            tgCtx.api,
            chatId,
            nextDraftId(chatId),
            getMessageThreadId(tgCtx),
            maxResponseLength,
            (err) => {
              log.warn(`chat${chatId} sendMessageDraft 预览失败，已降级跳过：${describeTelegramSendError(err)}`);
            },
          )
          : createSilentStreamUpdater();

        try {
          const result = await inst.prompt(promptMessage, images, {
            onStart,
            onTextDelta: (delta, fullText) => {
              streamedText = stripProtocolTags(fullText);
              stream.onTextDelta(delta, fullText);
            },
            onToolStart: stream.onToolStart,
            onToolError: stream.onToolError,
          });

          await stream.stopAndWait();
          const processed = await applyCronToolDirectives(tgCtx, result.text);

          await sendReply(tgCtx, processed.text, result.tools, maxResponseLength, processed.warnings);
        } finally {
          await stream.stopAndWait();
        }

        return;
      }

      const result = await inst.prompt(promptMessage, images, { onStart });
      await status?.delete().catch(() => {});
      const processed = await applyCronToolDirectives(tgCtx, result.text);
      await sendReply(tgCtx, processed.text, result.tools, maxResponseLength, processed.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "aborted") {
        if (status) {
          await reportStatusOrReply(tgCtx, status, "🛑 已中止");
        } else {
          await tgCtx.reply("🛑 已中止").catch(() => {});
        }
      } else if (useStream && streamedText.trim()) {
        const errLine = `⚠️ 生成中断：${truncate(message, 300)}`;
        const merged = truncate(`${streamedText}\n\n${errLine}`, maxResponseLength);
        if (status) {
          await reportStatusOrReply(tgCtx, status, merged);
        } else {
          await tgCtx.reply(merged).catch(() => {});
        }
      } else {
        const errorText = `❌ 错误：${message}`;
        if (status) {
          await reportStatusOrReply(tgCtx, status, errorText);
        } else {
          await tgCtx.reply(errorText).catch(() => {});
        }
      }
    } finally {
      tgCtx.chatAction = null;
    }
  };

  // Text messages
  bot.on("message:text", async (tgCtx) => {
    const text = tgCtx.message.text;
    if (!text) return;
    if (text.startsWith("/")) return;

    const pending = cronPendingInput.get(tgCtx.chat.id);
    if (pending) {
      const handled = await consumePendingCronInput(tgCtx, pending, text);
      if (handled) return;
    }

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

  // Generic files (documents)
  bot.on("message:document", async (tgCtx) => {
    const document = tgCtx.message.document;
    const baseText = tgCtx.message.caption || document.file_name || "请处理这个文件";
    rememberReplyMessage(replyScopeKey(tgCtx), "user", tgCtx.message.message_id, baseText);
    rememberReferencedReply(tgCtx);

    const key = chatKey(botKey, tgCtx.chat.id);
    const inst = pool.get(key);

    await runPromptRequest(tgCtx, inst, async ({ supportsImages }) => {
      const loaded = await downloadInboundFileByFileId(
        tgCtx,
        config.token,
        document.file_id,
        String(document.mime_type || "application/octet-stream"),
        supportsImages,
      );

      const currentImages = loaded?.image ? [loaded] : [];
      const currentFilePaths = loaded ? [normalizePromptPath(loaded.localPath)] : [];

      return buildPromptPayloadWithReplyContext(
        tgCtx,
        baseText,
        config.token,
        supportsImages,
        currentImages,
        currentFilePaths,
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
  currentFilePaths?: string[];
}

async function buildPromptPayloadWithReplyContext(
  tgCtx: BotContext,
  content: string,
  token: string,
  enableImages: boolean,
  currentImages: LoadedImage[] = [],
  currentFilePaths: string[] = [],
): Promise<{ message: string; images?: PiImage[] }> {
  const dedupeIds = new Set(currentImages.map((x) => x.fileId.toLowerCase()));
  const referencedImages = await collectReferencedImages(tgCtx, token, dedupeIds, enableImages);

  const deduped = dedupeLoadedImageGroups(currentImages, referencedImages);
  const normalizedCurrentFilePaths = normalizePromptPathList([
    ...currentFilePaths,
    ...toPromptPathList(deduped.current),
  ]);

  const message = buildUserMessageWithReplyContext(tgCtx, content, {
    currentImagePaths: toPromptPathList(deduped.current),
    referencedImagePaths: toPromptPathList(deduped.referenced),
    currentFilePaths: normalizedCurrentFilePaths,
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
  const currentFilePaths = opts.currentFilePaths ?? [];

  const targetText = extractMessageText(replied);
  const targetFrom = formatMessageSender(replied, tgCtx.me.id);
  const hasUsefulReply =
    !!targetText
    || !!quote
    || referencedImagePaths.length > 0
    || currentImagePaths.length > 0
    || currentFilePaths.length > 0;

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
    currentFilePaths.length > 0
      ? `current_file_paths:\n- ${currentFilePaths.join("\n- ")}`
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
  const loaded = await downloadInboundFileByFileId(
    tgCtx,
    token,
    fileId,
    fallbackMimeType,
    includeImage,
  );
  if (!loaded) return null;
  if (!loaded.image) return null;
  return loaded;
}

async function downloadInboundFileByFileId(
  tgCtx: BotContext,
  token: string,
  fileId: string,
  fallbackMimeType = "application/octet-stream",
  includeImage = true,
): Promise<LoadedImage | null> {
  try {
    const file = await tgCtx.api.getFile(fileId) as any;
    if (!file?.file_path) return null;

    const filePath = String(file.file_path);
    const mimeType = inferImageMimeFromPath(filePath, fallbackMimeType);
    const ext = inferImageExtFromPath(filePath, mimeType);
    const localPath = resolveInboundImagePath(tgCtx, fileId, ext);

    let buffer: Buffer | null = null;

    const hasLocal = existsSync(localPath);

    if (!hasLocal) {
      let downloaded = false;

      if (typeof file.download === "function") {
        try {
          await file.download(localPath);
          downloaded = true;
        } catch {
          downloaded = false;
        }
      }

      if (!downloaded) {
        const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
        const resp = await fetch(url);
        if (!resp.ok) return null;
        buffer = Buffer.from(await resp.arrayBuffer());
        await writeFile(localPath, buffer);
      }
    }

    let contentHash: string | undefined;

    const isImage = mimeType.startsWith("image/");
    if (includeImage && isImage) {
      if (!buffer) {
        buffer = await readFile(localPath);
      }
      contentHash = hashImageBuffer(buffer);
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
    }

    if (!buffer && isImage) {
      buffer = await readFile(localPath);
      contentHash = hashImageBuffer(buffer);
    }

    return { fileId, localPath, contentHash };
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

function describeTelegramSendError(err: unknown): string {
  if (err instanceof GrammyError) return err.description;
  if (err instanceof HttpError) return String(err);
  if (err instanceof Error) return err.message;
  return String(err);
}

function isMessageNotModifiedError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("message is not modified");
}

function isTextMustBeNonEmptyError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("text must be non-empty");
}

function isDraftHtmlParseError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  return text.includes("can't parse entities")
    || text.includes("cant parse entities")
    || text.includes("unsupported start tag")
    || text.includes("unexpected end tag")
    || text.includes("can't find end tag");
}

function isSendMessageDraftUnsupportedError(err: unknown): boolean {
  const text = describeTelegramSendError(err).toLowerCase();
  if (text.includes("sendmessagedraft")) return true;
  if (text.includes("method not found")) return true;
  if (text.includes("not implemented")) return true;
  return false;
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

function normalizePromptPathList(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const pRaw of paths) {
    const p = normalizePromptPath(String(pRaw || "").trim());
    if (!p) continue;
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
  stopAndWait: () => Promise<void>;
  dispose: () => void;
}

async function callSendMessageDraft(
  api: BotContext["api"],
  chatId: number,
  draftId: number,
  text: string,
  messageThreadId?: number,
  parseMode?: "HTML",
): Promise<void> {
  const other: Record<string, unknown> = {};
  if (Number.isSafeInteger(messageThreadId) && (messageThreadId as number) > 0) {
    other.message_thread_id = messageThreadId as number;
  }
  if (parseMode) {
    other.parse_mode = parseMode;
  }
  const sendOther = Object.keys(other).length > 0 ? other : undefined;

  const apiAny = api as any;

  if (typeof apiAny.sendMessageDraft === "function") {
    await apiAny.sendMessageDraft(chatId, draftId, text, sendOther);
    return;
  }

  if (typeof apiAny?.raw?.sendMessageDraft === "function") {
    await apiAny.raw.sendMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      text,
      ...(sendOther ?? {}),
    });
    return;
  }

  throw new Error("sendMessageDraft not supported by current grammY version");
}

function createDraftStreamUpdater(
  api: BotContext["api"],
  chatId: number,
  draftId: number,
  messageThreadId: number | undefined,
  maxLen: number,
  onDraftFallback?: (err: unknown) => void,
): StreamUpdater {
  const minEditIntervalMs = 700;
  // Must stay within Bot API text limit (4096)
  const safeLimit = Math.min(Math.max(200, maxLen - 600), 3800);
  let text = "";
  const tools: string[] = [];
  let lastRendered = "";
  let lastEditAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let disabled = false;
  let draftSupportsHtml = true;
  let pendingEdit: Promise<void> = Promise.resolve();

  const render = () => {
    if (disposed || disabled) return;

    const preview = buildStreamingPreview(text, tools, safeLimit);
    if (!preview) return;

    let plainDraftText = mdToPlainText(preview).trim();
    if (!plainDraftText || plainDraftText === "(无回复)") return;
    if (plainDraftText.length > 4096) {
      plainDraftText = `${plainDraftText.slice(0, 4095)}…`;
    }

    let draftText = plainDraftText;
    let parseMode: "HTML" | undefined;
    if (draftSupportsHtml) {
      const htmlDraftText = mdToTgHtml(preview).trim();
      if (htmlDraftText && htmlDraftText !== "(无回复)") {
        draftText = htmlDraftText;
        parseMode = "HTML";
      }
    }

    const renderKey = `${parseMode ?? "plain"}:${draftText}`;
    if (renderKey === lastRendered) return;

    lastRendered = renderKey;
    lastEditAt = Date.now();

    pendingEdit = pendingEdit
      .then(async () => {
        if (disposed || disabled) return;
        try {
          await callSendMessageDraft(api, chatId, draftId, draftText, messageThreadId, parseMode);
        } catch (err) {
          let sendErr: unknown = err;

          if (parseMode === "HTML" && isDraftHtmlParseError(sendErr)) {
            draftSupportsHtml = false;
            try {
              await callSendMessageDraft(api, chatId, draftId, plainDraftText, messageThreadId);
              lastRendered = `plain:${plainDraftText}`;
              return;
            } catch (fallbackErr) {
              sendErr = fallbackErr;
            }
          }

          if (isMessageNotModifiedError(sendErr)) return;
          if (isTextMustBeNonEmptyError(sendErr)) return;
          if (isSendMessageDraftUnsupportedError(sendErr)) {
            disabled = true;
          }
          try { onDraftFallback?.(sendErr); } catch { /* ignore callback error */ }
        }
      })
      .catch(() => {
        // keep chain alive
      });
  };

  const scheduleRender = () => {
    if (disposed || disabled) return;
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

  const dispose = () => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    onTextDelta: (_delta, fullText) => {
      text = stripProtocolTags(fullText);
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
    stopAndWait: async () => {
      dispose();
      await pendingEdit.catch(() => {
        // ignore
      });
    },
    dispose,
  };
}

function createSilentStreamUpdater(): StreamUpdater {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolError: () => {},
    stopAndWait: async () => {},
    dispose: () => {},
  };
}

function stripProtocolTags(text: string): string {
  let out = text;

  // Normal tags.
  out = out.replace(/<\/?\s*tg-(?:attachment|reply|cron)\b[^>]*>/gi, "");

  // Dangling/incomplete start tags.
  out = out.replace(/<\s*tg-(?:attachment|reply|cron)\b[^\r\n>]*/gi, "");

  // HTML-escaped tags.
  out = out.replace(/&lt;\/?\s*tg-(?:attachment|reply|cron)\b[\s\S]*?&gt;/gi, "");

  return out;
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

interface CronPreparedReply {
  body: string;
  attachments: TgAttachment[];
  warnings: string[];
}

function prepareCronReply(text: string, tools: string[]): CronPreparedReply {
  const extractedReply = extractTgReplyDirective(text || "");
  const extracted = extractTgAttachments(extractedReply.text);
  let body = stripProtocolTags(extracted.text);

  if (tools.length) {
    body = `${tools.join("\n")}${body ? `\n\n${body}` : ""}`;
  }

  if (!body.trim() && extracted.attachments.length === 0) {
    body = "(无回复)";
  }

  return {
    body,
    attachments: extracted.attachments,
    warnings: [...extractedReply.warnings, ...extracted.warnings],
  };
}

function prepareReply(
  tgCtx: BotContext,
  text: string,
  tools: string[],
  extraWarnings: string[] = [],
): PreparedReply {
  const extractedReply = extractTgReplyDirective(text || "");
  const extracted = extractTgAttachments(extractedReply.text);
  const resolvedReply = resolveReplyParameters(replyScopeKey(tgCtx), extractedReply.directive);
  let body = stripProtocolTags(extracted.text);

  if (tools.length) {
    body = `${tools.join("\n")}${body ? `\n\n${body}` : ""}`;
  }

  if (!body.trim() && extracted.attachments.length === 0) {
    body = "(无回复)";
  }

  return {
    body,
    attachments: extracted.attachments,
    warnings: [...extractedReply.warnings, ...extracted.warnings, ...resolvedReply.warnings, ...extraWarnings],
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
      } catch (err) {
        log.warn(`chat${tgCtx.chat?.id ?? 0} HTML 发送失败，降级纯文本：${describeTelegramSendError(err)}`);
        const safePart = stripProtocolTags(part);
        const plain = mdToPlainText(safePart);
        const sent = await tgCtx.reply(plain, opts);
        rememberReplyMessage(replyScopeKey(tgCtx), "self", sent.message_id, plain);
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

async function sendReply(
  tgCtx: BotContext,
  text: string,
  tools: string[],
  maxLen: number,
  extraWarnings: string[] = [],
): Promise<void> {
  const prepared = prepareReply(tgCtx, text, tools, extraWarnings);
  await sendPreparedReply(tgCtx, prepared, maxLen);
}

const CRON_HELP_TEXT = [
  "⏰ /cron 用法",
  "- /cron（打开交互菜单）",
  "- /cron list",
  "- /cron stat",
  "- /cron add at <ISO时间> <内容>（可用 名称||内容 指定任务名）",
  "- /cron add every <间隔> <内容>（如 10m、2h、1d；可用 名称||内容）",
  "- /cron add cron \"<表达式>\" [时区] <内容>（可用 名称||内容）",
  "- /cron on <id>",
  "- /cron off <id>",
  "- /cron del <id>",
  "- /cron rename <id> <新名称>",
  "- /cron run <id>",
].join("\n");

function extractCommandArgs(text: string, command: string): string {
  const re = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

function splitCommandArgs(input: string): string[] {
  if (!input.trim()) return [];
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    out.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return out;
}

function parseNamedPrompt(input: string): { name?: string; prompt: string } {
  const raw = String(input || "").trim();
  if (!raw) return { prompt: "" };

  const sep = raw.indexOf("||");
  if (sep < 0) {
    return { prompt: raw };
  }

  const left = raw.slice(0, sep).trim();
  const right = raw.slice(sep + 2).trim();
  if (!right) {
    return { prompt: raw };
  }

  return {
    name: left || undefined,
    prompt: right,
  };
}

function parseDurationMs(input: string): number | undefined {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return undefined;

  const re = /(\d+)\s*(d|h|m|s)/g;
  let total = 0;
  let matched = "";
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null) {
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 0) return undefined;

    switch (m[2]) {
      case "d": total += n * 24 * 60 * 60 * 1000; break;
      case "h": total += n * 60 * 60 * 1000; break;
      case "m": total += n * 60 * 1000; break;
      case "s": total += n * 1000; break;
      default: return undefined;
    }

    matched += m[0];
  }

  const compactInput = s.replace(/\s+/g, "");
  const compactMatched = matched.replace(/\s+/g, "");
  if (!compactMatched || compactMatched !== compactInput) return undefined;
  if (total < 1000) return undefined;
  return total;
}

function looksLikeTimezone(input: string): boolean {
  const s = String(input || "").trim();
  if (!s) return false;
  if (s === "UTC" || s === "GMT") return true;
  if (/^(UTC|GMT)[+-]\d{1,2}$/.test(s)) return true;
  return /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/.test(s);
}

function formatDateTime(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function formatCompactDuration(ms: number): string {
  const totalSec = Math.max(1, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (secs || !parts.length) parts.push(`${secs}s`);
  return parts.join("");
}

function formatCronSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `at ${formatDateTime(schedule.atMs)}`;
    case "every":
      return `every ${formatCompactDuration(schedule.everyMs)}（anchor=${formatDateTime(schedule.anchorMs)}）`;
    case "cron":
      return `cron "${schedule.expr}" @${schedule.timezone}`;
    default:
      return "unknown";
  }
}

function formatCronJobLine(job: CronJobRecord): string {
  const status = job.enabled ? "🟢" : "⚪";
  const running = job.state.runningRunId ? " ⏳running" : "";
  const lastStatus = job.state.lastStatus ? ` | last=${job.state.lastStatus}` : "";
  const lastErr = job.state.lastError ? ` | err=${truncate(job.state.lastError, 40)}` : "";

  return [
    `${status} ${job.id}${running}`,
    `  ${truncate(job.name, 70)}`,
    `  ${formatCronSchedule(job.schedule)}`,
    `  next=${formatDateTime(job.state.nextRunAtMs)}${lastStatus}${lastErr}`,
  ].join("\n");
}

function formatCronStatus(st: { enabled: boolean; totalJobs: number; enabledJobs: number; runningJobs: number; queuedJobs: number; nextRunAtMs?: number }): string {
  return [
    `⏰ 定时服务：${st.enabled ? "开启" : "关闭"}`,
    `总任务：${st.totalJobs}`,
    `启用：${st.enabledJobs}`,
    `运行中：${st.runningJobs}`,
    `队列中：${st.queuedJobs}`,
    `最近下次触发：${formatDateTime(st.nextRunAtMs)}`,
  ].join("\n");
}
