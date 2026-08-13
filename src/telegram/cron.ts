import type { Bot, Context } from "grammy";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import type { CommandGroup } from "@grammyjs/commands";
import { Menu } from "@grammyjs/menu";
import { log } from "../platform/logger.js";
import type { AgentPool } from "../agent.js";
import type { Scheduler } from "../scheduler.js";
import type { CronJobRecord, CronSchedule } from "../types.js";
import {
  buildRichMessage,
  describeTelegramSendError,
  formatCronJobLine,
  formatCronSchedule,
  formatCronStatus,
  formatDateTime,
  getCronHelpText,
  extractCommandArgs,
  isMessageNotModifiedError,
  looksLikeTimezone,
  parseDurationMs,
  parseNamedPrompt,
  prepareCronReply,
  sendAttachmentByApi,
  splitCommandArgs,
  splitMessage,
} from "./presentation.js";
import {
  extractTgCronDirectives,
  type TgCronDirective,
  rememberReplyMessage,
} from "./protocol.js";
import { chatKey, truncate } from "./media.js";
import { t } from "../i18n.js";

export type TelegramContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export interface CronFeatureOptions {
  bot: Bot<TelegramContext>;
  botIndex: number;
  botKey: string;
  pool: AgentPool;
  cron: Scheduler;
  commandGroup: CommandGroup<TelegramContext>;
  maxResponseLength: number;
}

export interface CronFeatures {
  applyToolDirectives: (context: TelegramContext, text: string) => Promise<{ text: string; warnings: string[] }>;
  consumePendingInput: (context: TelegramContext, text: string) => Promise<boolean>;
}

export function createCronFeatures(options: CronFeatureOptions): CronFeatures {
  const { bot, botIndex, botKey, pool, cron, commandGroup, maxResponseLength } = options;

  let cronScopeBotId: number | null = null;
  const getCronReplyScope = async (chatId: number): Promise<string> => {
    if (cronScopeBotId == null) {
      const me = await bot.api.getMe();
      cronScopeBotId = me.id;
    }
    return `${cronScopeBotId}:${chatId}`;
  };

  const sendCronReply = async (chatId: number, text: string, tools: string[]): Promise<void> => {
    const prepared = prepareCronReply(text, tools);
    const scope = await getCronReplyScope(chatId);

    if (prepared.warnings.length) {
      const preview = prepared.warnings.slice(0, 3).join("\n");
      const more = prepared.warnings.length > 3 ? t("\n... 还有 {count} 条", { count: prepared.warnings.length - 3 }) : "";
      await bot.api.sendMessage(chatId, t("⚠️ 附件解析告警：\n{preview}{more}", { preview, more })).catch(() => {});
    }

    if (prepared.body.trim()) {
      for (const part of splitMessage(prepared.body, maxResponseLength)) {
        const sent = await bot.api.sendRichMessage(chatId, buildRichMessage(part));
        rememberReplyMessage(scope, "self", sent.message_id, part);
      }
    }

    for (const attachment of prepared.attachments) {
      try {
        await sendAttachmentByApi(bot.api, chatId, attachment);
      } catch (err) {
        await bot.api.sendMessage(chatId, t("❌ 附件发送失败：{label}\n{message}", {
          label: attachment.label || t("未知附件"),
          message: (err as Error).message,
        })).catch(() => {});
      }
    }
  };

  cron.setExecutor(async ({ job }) => {
    const key = chatKey(botKey, job.chatId);
    const session = pool.get(key);

    try {
      const result = await session.prompt(job.prompt);
      await sendCronReply(job.chatId, result.text, result.tools);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await bot.api.sendMessage(
        job.chatId,
        t("❌ 定时任务「{name}」执行失败：{message}", {
          name: job.name || job.id,
          message: truncate(message, 1500),
        }),
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
      ? t("\n当前等待输入：{kind}（请直接发送文本，或在菜单中取消）", { kind: pending.kind })
      : "";
    return t("⏰ 定时任务菜单{hint}", { hint });
  };

  const setCronMenuPage = (chatId: number, page: number, totalPages: number): number => {
    const safeTotal = Math.max(1, totalPages);
    const next = Math.max(0, Math.min(page, safeTotal - 1));
    cronMenuPageByChat.set(chatId, next);
    return next;
  };

  const upsertCronMenuMessage = async (context: TelegramContext): Promise<void> => {
    const chatId = context.chat?.id ?? 0;
    const text = buildCronMenuTitle(chatId);
    const existingId = cronMenuMessageByChat.get(chatId);

    await ensureCronMenuReady(context);

    if (existingId) {
      try {
        await context.api.editMessageText(chatId, existingId, text, { reply_markup: cronMenu });
        return;
      } catch (err) {
        if (isMessageNotModifiedError(err)) return;
        cronMenuMessageByChat.delete(chatId);
        log.warn(t("chat{chatId} 更新 /cron 菜单失败，将尝试重新发送：{message}", {
          chatId,
          message: describeTelegramSendError(err),
        }));
      }
    }

    const sent = await context.reply(text, { reply_markup: cronMenu });
    cronMenuMessageByChat.set(chatId, sent.message_id);
  };

  const cronMenu = new Menu<TelegramContext>(cronRootMenuId, {
    onMenuOutdated: t("菜单已更新，请重试"),
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
      t("📊 {state} | 任务 {total} | 运行 {running} | 队列 {queued}", {
        state: st.enabled ? t("开启") : t("关闭"),
        total: st.totalJobs,
        running: st.runningJobs,
        queued: st.queuedJobs,
      }),
      (ctx) => ctx.answerCallbackQuery({ text: t("状态已更新") }),
    ).row();

    range.text(t("🔄 刷新"), async (ctx) => {
      try { ctx.menu.update(); } catch { /* ignore */ }
      await ctx.answerCallbackQuery({ text: t("已刷新") });
    });

    range.text(t("➕ 一次性"), async (ctx) => {
      cronPendingInput.set(chatId, { kind: "at", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: t("请发送: <ISO时间> <内容>") });
      await ctx.reply(t("🕒 请输入一次性任务：\n<ISO时间> <内容>\n可选名称：<ISO时间> <名称||内容>\n例如：2026-03-01T09:00:00+08:00 早报总结"));
      try { ctx.menu.update(); } catch { /* ignore */ }
    }).row();

    range.text(t("➕ 间隔"), async (ctx) => {
      cronPendingInput.set(chatId, { kind: "every", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: t("请发送: <间隔> <内容>") });
      await ctx.reply(t("⏱ 请输入间隔任务：\n<间隔> <内容>\n可选名称：<间隔> <名称||内容>\n例如：10m 检查报警\n支持：s/m/h/d"));
      try { ctx.menu.update(); } catch { /* ignore */ }
    });

    range.text("➕ Cron", async (ctx) => {
      cronPendingInput.set(chatId, { kind: "cron", startedAt: Date.now() });
      await ctx.answerCallbackQuery({ text: t("请发送: <表达式> | [时区] | [名称] | <内容>") });
      await ctx.reply(t("🧩 请输入 Cron 任务：\n<表达式> | [时区] | [名称] | <内容>\n例如：0 9 * * 1-5 | Asia/Shanghai | 工作日早报 | 汇总日报"));
      try { ctx.menu.update(); } catch { /* ignore */ }
    }).row();

    if (pending) {
      const ageSec = Math.max(0, Math.floor((Date.now() - pending.startedAt) / 1000));
      range.text(t("❌ 取消输入（{kind}, {seconds}s）", { kind: pending.kind, seconds: ageSec }), async (ctx) => {
        cronPendingInput.delete(chatId);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: t("已取消") });
      }).row();
    }

    if (!jobs.length) {
      range.text(t("当前无任务"), (ctx) => ctx.answerCallbackQuery({ text: t("暂无任务") }));
      return;
    }

    range.text(t("📄 第 {page}/{total} 页", { page: page + 1, total: totalPages }), (ctx) =>
      ctx.answerCallbackQuery({ text: t("本页 {count} 条", { count: pageJobs.length }) }),
    ).row();

    for (const job of pageJobs) {
      const icon = job.enabled ? "🟢" : "⚪";
      const running = job.state.runningRunId ? " ⏳" : "";
      range.text(`${icon}${running} ${truncate(job.name, 18)} [${job.id}]`, (ctx) =>
        ctx.answerCallbackQuery({ text: `${formatCronSchedule(job.schedule)} | next=${formatDateTime(job.state.nextRunAtMs)}`.slice(0, 190) }),
      ).row();

      range.text(job.enabled ? t("⏸ 停用") : t("▶️ 启用"), async (ctx) => {
        await cron.setEnabled(job.id, !job.enabled);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: job.enabled ? t("已停用") : t("已启用") });
      });

      range.text(t("▶️ 执行"), async (ctx) => {
        const ok = await cron.runNow(job.id);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: ok ? t("已加入执行队列") : t("加入失败") });
      });

      range.text(t("✏️ 改名"), async (ctx) => {
        cronPendingInput.set(chatId, { kind: "rename", jobId: job.id, startedAt: Date.now() });
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: t("请发送新名称") });
        await ctx.reply(t("✏️ 请发送任务 {id} 的新名称", { id: job.id }));
      }).row();

      range.text(t("🗑 删除"), async (ctx) => {
        await cron.remove(job.id);
        const nextTotalPages = Math.max(1, Math.ceil(Math.max(0, jobs.length - 1) / CRON_MENU_PAGE_SIZE));
        setCronMenuPage(chatId, page, nextTotalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: t("已删除") });
      }).row();
    }

    if (totalPages > 1) {
      range.text(t("⬅️ 上一页"), async (ctx) => {
        setCronMenuPage(chatId, page - 1, totalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: t("第 {page} 页", { page: Math.max(1, page) }) });
      });

      range.text(t("➡️ 下一页"), async (ctx) => {
        setCronMenuPage(chatId, page + 1, totalPages);
        try { ctx.menu.update(); } catch { /* ignore */ }
        await ctx.answerCallbackQuery({ text: t("第 {page} 页", { page: Math.min(totalPages, page + 2) }) });
      }).row();
    }
  });

  bot.use(cronMenu);

  const ensureCronMenuReady = async (context: TelegramContext): Promise<void> => {
    await cronMenu.middleware()(context, async () => {});
  };

  commandGroup.command("cron", t("管理定时任务"), async (context) => {
    try {
      const raw = extractCommandArgs(String((context.message as any)?.text || ""), "cron");
      const chatId = context.chat.id;

      if (!raw.trim()) {
        await upsertCronMenuMessage(context);
        return;
      }

      const args = splitCommandArgs(raw);
      const sub = (args.shift() || "help").toLowerCase();

    if (sub === "help" || sub === "h" || sub === "?") {
      await context.reply(getCronHelpText());
      return;
    }

    if (sub === "list" || sub === "ls") {
      const jobs = cron.list(chatId);
      if (!jobs.length) {
        await context.reply(t("当前聊天暂无定时任务。使用 /cron add ... 创建。"));
        return;
      }

      const lines = jobs.map((job) => formatCronJobLine(job));
      const text = t("⏰ 定时任务（{count}）\n{jobs}", { count: jobs.length, jobs: lines.join("\n") });
      for (const part of splitMessage(text, maxResponseLength)) {
        await context.reply(part);
      }
      return;
    }

    if (sub === "stat" || sub === "status") {
      const st = cron.status(chatId);
      await context.reply(formatCronStatus(st));
      return;
    }

    if (sub === "add") {
      const kind = (args.shift() || "").toLowerCase();
      if (!kind) {
        await context.reply(t("用法：/cron add at|every|cron ..."));
        return;
      }

      if (kind === "at") {
        const atRaw = args.shift() || "";
        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        if (!atRaw || !prompt) {
          await context.reply(t("用法：/cron add at <ISO时间> <内容>"));
          return;
        }

        const atMs = new Date(atRaw).getTime();
        if (!Number.isFinite(atMs)) {
          await context.reply(t("时间格式非法，请使用 ISO 8601，例如 2026-03-01T09:00:00+08:00"));
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "at", atMs },
        });
        await context.reply(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: job.id,
          schedule: formatCronSchedule(job.schedule),
          name: job.name,
        }));
        return;
      }

      if (kind === "every") {
        const everyRaw = args.shift() || "";
        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        const everyMs = parseDurationMs(everyRaw);
        if (!everyMs || !prompt) {
          await context.reply(t("用法：/cron add every <间隔> <内容>\n示例：/cron add every 10m 早报总结"));
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() },
        });
        await context.reply(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: job.id,
          schedule: formatCronSchedule(job.schedule),
          name: job.name,
        }));
        return;
      }

      if (kind === "cron") {
        const expr = args.shift() || "";
        if (!expr) {
          await context.reply(t("用法：/cron add cron \"<表达式>\" [时区] <内容>"));
          return;
        }

        let timezone = cron.getDefaultTimezone();
        if (args.length >= 2 && looksLikeTimezone(args[0])) {
          timezone = args.shift()!;
        }

        const named = parseNamedPrompt(args.join(" "));
        const prompt = named.prompt;
        if (!prompt) {
          await context.reply(t("用法：/cron add cron \"<表达式>\" [时区] <内容>"));
          return;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "cron", expr, timezone },
        });

        await context.reply(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: job.id,
          schedule: formatCronSchedule(job.schedule),
          name: job.name,
        }));
        return;
      }

      await context.reply(t("不支持的类型，仅支持 at / every / cron"));
      return;
    }

    if (sub === "on" || sub === "off") {
      const id = (args.shift() || "").trim();
      if (!id) {
        await context.reply(t("用法：/cron on <id> 或 /cron off <id>"));
        return;
      }
      const updated = await cron.setEnabled(id, sub === "on");
      if (!updated || updated.chatId !== chatId) {
        await context.reply(t("未找到该任务（或不属于当前聊天）"));
        return;
      }
      await context.reply(t("✅ 任务 {id} 已{state}", { id, state: sub === "on" ? t("启用") : t("停用") }));
      return;
    }

    if (sub === "del" || sub === "rm" || sub === "remove") {
      const id = (args.shift() || "").trim();
      if (!id) {
        await context.reply(t("用法：/cron del <id>"));
        return;
      }
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        await context.reply(t("未找到该任务（或不属于当前聊天）"));
        return;
      }
      await cron.remove(id);
      await context.reply(t("🗑 已删除任务 {id}", { id }));
      return;
    }

    if (sub === "rename" || sub === "name") {
      const id = (args.shift() || "").trim();
      const newName = args.join(" ").trim();
      if (!id || !newName) {
        await context.reply(t("用法：/cron rename <id> <新名称>"));
        return;
      }
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        await context.reply(t("未找到该任务（或不属于当前聊天）"));
        return;
      }
      const updated = await cron.rename(id, newName);
      if (!updated) {
        await context.reply(t("重命名失败"));
        return;
      }
      await context.reply(t("✏️ 任务 {id} 已重命名为：{name}", { id, name: updated.name }));
      return;
    }

    if (sub === "run") {
      const id = (args.shift() || "").trim();
      if (!id) {
        await context.reply(t("用法：/cron run <id>"));
        return;
      }
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        await context.reply(t("未找到该任务（或不属于当前聊天）"));
        return;
      }
      const ok = await cron.runNow(id);
      await context.reply(ok ? t("▶️ 任务 {id} 已加入执行队列", { id }) : t("加入队列失败"));
      return;
    }

      await context.reply(t("未知子命令。发送 /cron help 查看用法。"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await context.reply(t("❌ cron 操作失败：{message}", { message: truncate(message, 1000) })).catch(() => {});
    }
  });


  const executeCronDirectiveForChat = async (
    chatId: number,
    directive: TgCronDirective,
  ): Promise<{ notices: string[]; warnings: string[] }> => {
    const notices: string[] = [];
    const warnings: string[] = [];

    const ensureOwned = (id: string): CronJobRecord => {
      const job = cron.get(id);
      if (!job || job.chatId !== chatId) {
        throw new Error(t("未找到该任务（或不属于当前聊天）"));
      }
      return job;
    };

    switch (directive.action) {
      case "list": {
        const jobs = cron.list(chatId);
        if (!jobs.length) {
          notices.push(t("⏰ 当前聊天暂无定时任务。"));
          break;
        }
        notices.push(t("⏰ 定时任务（{count}）\n{jobs}", { count: jobs.length, jobs: jobs.map((x) => formatCronJobLine(x)).join("\n") }));
        break;
      }

      case "stat": {
        notices.push(formatCronStatus(cron.status(chatId)));
        break;
      }

      case "add": {
        const prompt = String(directive.prompt || "").trim();
        if (!prompt) throw new Error(t("add 缺少任务内容"));

        const kind = directive.kind;
        if (!kind) throw new Error(t("add 缺少 kind"));

        let schedule: CronSchedule;

        if (kind === "at") {
          const atRaw = String(directive.at || "").trim();
          const atMs = new Date(atRaw).getTime();
          if (!Number.isFinite(atMs)) {
            throw new Error(t("add kind=at 的 at 时间非法（需 ISO 时间）"));
          }
          schedule = { kind: "at", atMs };
        } else if (kind === "every") {
          const everyMs = parseDurationMs(String(directive.every || "").trim());
          if (!everyMs) {
            throw new Error(t("add kind=every 的 every 非法（如 10m/2h/1d）"));
          }
          schedule = { kind: "every", everyMs, anchorMs: Date.now() };
        } else {
          const expr = String(directive.expr || "").trim();
          if (!expr) throw new Error(t("add kind=cron 缺少 expr"));

          const tzRaw = String(directive.timezone || "").trim();
          const timezone = tzRaw || cron.getDefaultTimezone();
          if (!looksLikeTimezone(timezone)) {
            throw new Error(t("timezone 非法：{timezone}", { timezone }));
          }
          schedule = { kind: "cron", expr, timezone };
        }

        const created = await cron.create({
          chatId,
          name: directive.name,
          prompt,
          schedule,
        });

        notices.push(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: created.id,
          schedule: formatCronSchedule(created.schedule),
          name: created.name,
        }));
        break;
      }

      case "on": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error(t("on 缺少 id"));
        ensureOwned(id);
        await cron.setEnabled(id, true);
        notices.push(t("✅ 任务 {id} 已启用", { id }));
        break;
      }

      case "off": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error(t("off 缺少 id"));
        ensureOwned(id);
        await cron.setEnabled(id, false);
        notices.push(t("✅ 任务 {id} 已停用", { id }));
        break;
      }

      case "del": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error(t("del 缺少 id"));
        ensureOwned(id);
        await cron.remove(id);
        notices.push(t("🗑 已删除任务 {id}", { id }));
        break;
      }

      case "rename": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error(t("rename 缺少 id"));
        ensureOwned(id);

        const newName = String(directive.name || "").trim();
        if (!newName) throw new Error(t("rename 缺少 name"));

        const updated = await cron.rename(id, newName);
        if (!updated) throw new Error(t("rename 失败"));

        notices.push(t("✏️ 任务 {id} 已重命名为：{name}", { id, name: updated.name }));
        break;
      }

      case "run": {
        const id = String(directive.id || "").trim();
        if (!id) throw new Error(t("run 缺少 id"));
        ensureOwned(id);
        const ok = await cron.runNow(id);
        notices.push(ok ? t("▶️ 任务 {id} 已加入执行队列", { id }) : t("❌ 任务 {id} 加入队列失败", { id }));
        break;
      }

      default:
        warnings.push(t("不支持的 tg-cron action: {action}", { action: (directive as any).action }));
        break;
    }

    return { notices, warnings };
  };

  const applyCronToolDirectives = async (
    context: TelegramContext,
    text: string,
  ): Promise<{ text: string; warnings: string[] }> => {
    const extracted = extractTgCronDirectives(text || "");
    const warnings = [...extracted.warnings];
    const notices: string[] = [];
    const chatId = context.chat?.id ?? 0;

    for (const directive of extracted.directives) {
      try {
        const res = await executeCronDirectiveForChat(chatId, directive);
        notices.push(...res.notices);
        warnings.push(...res.warnings);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(t("tg-cron({action}) 执行失败：{message}", { action: directive.action, message }));
      }
    }

    const mergedText = [extracted.text.trim(), ...notices].filter(Boolean).join("\n\n");
    return { text: mergedText, warnings };
  };

  const consumePendingCronInput = async (
    context: TelegramContext,
    pending: CronPendingInput,
    text: string,
  ): Promise<boolean> => {
    const chatId = context.chat?.id ?? 0;
    const raw = String(text || "").trim();
    if (!raw) return true;

    try {
      if (pending.kind === "rename") {
        const job = cron.get(pending.jobId);
        if (!job || job.chatId !== chatId) {
          cronPendingInput.delete(chatId);
          await context.reply(t("❌ 目标任务不存在或不属于当前聊天"));
          return true;
        }

        const updated = await cron.rename(pending.jobId, raw);
        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(context);
        if (!updated) {
          await context.reply(t("❌ 重命名失败"));
          return true;
        }

        await context.reply(t("✏️ 任务 {id} 已重命名为：{name}", { id: updated.id, name: updated.name }));
        return true;
      }

      if (pending.kind === "at") {
        const firstSpace = raw.indexOf(" ");
        if (firstSpace < 0) {
          await context.reply(t("❌ 格式不对，请发送：<ISO时间> <内容>"));
          return true;
        }

        const atRaw = raw.slice(0, firstSpace).trim();
        const named = parseNamedPrompt(raw.slice(firstSpace + 1));
        const prompt = named.prompt;
        const atMs = new Date(atRaw).getTime();

        if (!Number.isFinite(atMs) || !prompt) {
          await context.reply(t("❌ 格式不对，请发送：<ISO时间> <内容>"));
          return true;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "at", atMs },
        });

        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(context);
        await context.reply(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: job.id,
          schedule: formatCronSchedule(job.schedule),
          name: job.name,
        }));
        return true;
      }

      if (pending.kind === "every") {
        const firstSpace = raw.indexOf(" ");
        if (firstSpace < 0) {
          await context.reply(t("❌ 格式不对，请发送：<间隔> <内容>，例如：10m 检查报警"));
          return true;
        }

        const everyRaw = raw.slice(0, firstSpace).trim();
        const named = parseNamedPrompt(raw.slice(firstSpace + 1));
        const prompt = named.prompt;
        const everyMs = parseDurationMs(everyRaw);

        if (!everyMs || !prompt) {
          await context.reply(t("❌ 间隔格式非法，支持：s/m/h/d（如 30s、10m、2h、1d）"));
          return true;
        }

        const job = await cron.create({
          chatId,
          name: named.name,
          prompt,
          schedule: { kind: "every", everyMs, anchorMs: Date.now() },
        });

        cronPendingInput.delete(chatId);
        await upsertCronMenuMessage(context);
        await context.reply(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: job.id,
          schedule: formatCronSchedule(job.schedule),
          name: job.name,
        }));
        return true;
      }

      // pending.kind === "cron"
      const parts = raw.split("|").map((x) => x.trim()).filter(Boolean);
      if (parts.length < 2) {
        await context.reply(t("❌ 格式不对，请发送：<表达式> | [时区] | [名称] | <内容>"));
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
        await context.reply(t("❌ 缺少任务内容，请发送：<表达式> | [时区] | [名称] | <内容>"));
        return true;
      }

      if (!looksLikeTimezone(timezone)) {
        await context.reply(t("❌ 时区格式非法：{timezone}", { timezone }));
        return true;
      }

      const job = await cron.create({
        chatId,
        name,
        prompt,
        schedule: { kind: "cron", expr, timezone },
      });

      cronPendingInput.delete(chatId);
      await upsertCronMenuMessage(context);
      await context.reply(t("✅ 已创建任务 {id}\n{schedule}\n名称：{name}", {
          id: job.id,
          schedule: formatCronSchedule(job.schedule),
          name: job.name,
        }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await context.reply(t("❌ 创建任务失败：{message}\n可继续输入，或打开 /cron 菜单取消", { message: truncate(message, 800) })).catch(() => {});
      return true;
    }
  };


    return {
      applyToolDirectives: applyCronToolDirectives,
      consumePendingInput: async (context, text) => {
        const pending = cronPendingInput.get(context.chat?.id ?? 0);
        return pending ? consumePendingCronInput(context, pending, text) : false;
      },
    };
  }
