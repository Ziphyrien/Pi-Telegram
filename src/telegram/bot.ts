import { createHash } from "node:crypto";
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrate } from "@grammyjs/hydrate";
import { hydrateFiles } from "@grammyjs/files";
import { CommandGroup } from "@grammyjs/commands";
import { autoChatAction } from "@grammyjs/auto-chat-action";
import { log } from "../platform/logger.js";
import { AgentPool } from "../agent.js";
import { Scheduler } from "../scheduler.js";
import type { BotConfig, PiImage, PiSessionStats } from "../types.js";
import { createBotMenus } from "./menus.js";
import { createCronFeatures } from "./cron.js";
import {
  buildStatusLines,
  createDraftStreamUpdater,
  createSilentStreamUpdater,
  stripProtocolTags,
  describeTelegramSendError,
  sendPreparedReply,
  sendReply,
} from "./presentation.js";
import { rememberReplyMessage } from "./protocol.js";
import {
  buildPromptPayloadWithReplyContext,
  downloadImageByFileId,
  downloadInboundFileByFileId,
  normalizePromptPath,
  parseModelImageSupport,
  rememberReferencedReply,
  chatKey,
  replyScopeKey,
  truncate,
} from "./media.js";
import { t } from "../i18n.js";

type BotContext = HydrateFlavor<Context> & AutoChatActionFlavor;

export interface CreateBotOptions {
  botIndex: number;
  config: BotConfig;
  pool: AgentPool;
  cron: Scheduler;
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
    outdatedMenuText: t("菜单已更新，请重试"),
    initialStreamByChat,
    onStreamModeChange,
  });

  const { modelMenu, streamMenu, thinkingMenu } = menus;
  bot.use(modelMenu);
  bot.use(streamMenu);
  bot.use(thinkingMenu);

  // Auth guard
  if (config.allowedUsers.length) {
    bot.use(async (context, next) => {
      const uid = context.from?.id;
      const uname = context.from?.username;
      if (config.allowedUsers.includes(uid!) || config.allowedUsers.includes(uname!)) {
        return next();
      }
      await context.reply(t("⛔ 无权限"));
    });
  }

  const commandGroup = new CommandGroup<BotContext>();
  bot.use(commandGroup);

  const abortNoticeSuppressionByChat = new Map<number, number[]>();
  const ABORT_NOTICE_SUPPRESS_TTL_MS = 15_000;
  type ActivePromptMode = "stream" | "non-stream";
  type ActivePromptState = { token: symbol; mode: ActivePromptMode; done: Promise<void> };
  type AbortDirective = { sendPartial: boolean; showAbortNotice: boolean };
  const activePromptByChat = new Map<number, ActivePromptState>();
  const abortDirectiveByPromptToken = new Map<symbol, AbortDirective>();

  const suppressAbortNotice = (chatId: number, count = 1): void => {
    if (!Number.isSafeInteger(chatId) || count <= 0) return;

    const now = Date.now();
    const list = (abortNoticeSuppressionByChat.get(chatId) ?? [])
      .filter((expiresAt) => expiresAt > now);
    const expiresAt = now + ABORT_NOTICE_SUPPRESS_TTL_MS;

    for (let i = 0; i < count; i += 1) {
      list.push(expiresAt);
    }

    abortNoticeSuppressionByChat.set(chatId, list);
  };

  const consumeAbortNoticeSuppression = (chatId: number): boolean => {
    const now = Date.now();
    const list = abortNoticeSuppressionByChat.get(chatId);
    if (!list?.length) return false;

    const alive = list.filter((expiresAt) => expiresAt > now);
    if (!alive.length) {
      abortNoticeSuppressionByChat.delete(chatId);
      return false;
    }

    alive.shift();
    if (alive.length) {
      abortNoticeSuppressionByChat.set(chatId, alive);
    } else {
      abortNoticeSuppressionByChat.delete(chatId);
    }

    return true;
  };

  const createActivePromptTracker = (chatId: number, mode: ActivePromptMode) => {
    const token = Symbol(`prompt:${chatId}:${mode}`);
    let started = false;
    let finished = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    return {
      token,
      onStart: () => {
        if (started) return;
        started = true;
        activePromptByChat.set(chatId, { token, mode, done });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        const current = activePromptByChat.get(chatId);
        if (current?.token === token) {
          activePromptByChat.delete(chatId);
        }
        abortDirectiveByPromptToken.delete(token);
        resolveDone();
      },
      done,
    };
  };

  const cancelQueuedSilently = (chatId: number, session: ReturnType<AgentPool["has"]>): number => {
    if (!session?.alive) return 0;
    const queued = session.queuedCount;
    if (queued > 0) {
      suppressAbortNotice(chatId, queued);
      session.cancelQueued();
    }
    return queued;
  };

  const abortActivePrompt = async (
    chatId: number,
    session: ReturnType<AgentPool["has"]>,
    opts: { sendPartial: boolean; showAbortNotice: boolean },
  ): Promise<{ aborted: boolean; mode?: ActivePromptMode }> => {
    const active = activePromptByChat.get(chatId);
    if (!active || !session?.alive) return { aborted: false };

    abortDirectiveByPromptToken.set(active.token, {
      sendPartial: opts.sendPartial,
      showAbortNotice: opts.showAbortNotice,
    });
    session.abort();
    await active.done;
    return { aborted: true, mode: active.mode };
  };

  commandGroup.command("status", t("查看状态"), async (context) => {
    const chatId = context.chat.id;
    const key = chatKey(botKey, chatId);
    const session = pool.has(key);
    let modelLabel = t("默认");
    let providerLabel = "";
    let thinkingSupported = true;
    let thinkingLabel = "";
    let sessionLabel = "";
    let cost: number | undefined;
    let contextUsage: PiSessionStats["contextUsage"] | undefined;

    if (session?.alive) {
      try {
        const st = await session.getState();
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
        const stats = await session.getSessionStats();
        if (typeof stats.cost === "number" && stats.cost > 0) {
          cost = stats.cost;
        }
        contextUsage = stats.contextUsage;
      } catch { /* ignore */ }
    }

    const cronSt = cron.status(chatId);
    const lines = buildStatusLines({
      alive: Boolean(session?.alive),
      processing: Boolean(session?.streaming),
      providerLabel,
      modelLabel,
      streamEnabled: menus.isStreamEnabled(chatId),
      thinkingLabel,
      sessionLabel,
      cost,
      contextUsage,
      activeCount: pool.size,
      cron: cronSt,
    });

    await context.reply(lines.join("\n"));
  });

  commandGroup.command("new", t("新建会话"), async (context) => {
    const chatId = context.chat.id;
    const key = chatKey(botKey, chatId);
    const session = pool.has(key);

    if (session?.alive) {
      cancelQueuedSilently(chatId, session);
      await abortActivePrompt(chatId, session, {
        sendPartial: true,
        showAbortNotice: true,
      });
    }

    try {
      await pool.getFresh(key);
      await context.reply(t("🆕 已新建会话"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await context.reply(t("❌ 新建会话失败：{message}", { message: truncate(message, 1000) }));
    }
  });

  commandGroup.command("abort", t("中止当前操作"), async (context) => {
    const chatId = context.chat.id;
    const key = chatKey(botKey, chatId);
    const session = pool.has(key);

    if (!session?.alive) {
      await context.reply(t("当前无操作"));
      return;
    }

    const queued = session.queuedCount;
    const stopped = await abortActivePrompt(chatId, session, {
      sendPartial: true,
      showAbortNotice: true,
    });

    if (stopped.aborted) {
      if (queued > 0) {
        await context.reply(t("📥 队列保留 {count} 条，继续执行中\n如需清空队列可用 /abortall", { count: queued }));
      }
      return;
    }

    if (queued > 0) {
      await context.reply(t("当前无运行任务，队列中还有 {count} 条", { count: queued }));
      return;
    }

    await context.reply(t("当前无操作"));
  });

  commandGroup.command("abortall", t("中止并清空队列"), async (context) => {
    const chatId = context.chat.id;
    const key = chatKey(botKey, chatId);
    const session = pool.has(key);

    if (!session?.alive || (!session.running && session.queuedCount === 0)) {
      await context.reply(t("当前无操作"));
      return;
    }

    const cleared = cancelQueuedSilently(chatId, session);
    const stopped = await abortActivePrompt(chatId, session, {
      sendPartial: true,
      showAbortNotice: true,
    });

    if (cleared > 0) {
      await context.reply(t("🧹 已清空队列 {count} 条", { count: cleared }));
      return;
    }

    if (!stopped.aborted) {
      await context.reply(t("当前无运行任务"));
    }
  });


  commandGroup.command("model", t("切换模型"), async (context) => {
    const chatId = context.chat.id;

    try {
      await menus.refreshModelsForChat(chatId);
    } catch (err) {
      await context.reply(t("❌ 获取模型列表失败：{message}", { message: (err as Error).message }));
      return;
    }

    await context.reply(t("🔄 选择 Provider:"), { reply_markup: modelMenu });
  });

  commandGroup.command("stream", t("切换流式输出"), async (context) => {
    await context.reply(t("⚙️ 输出模式:"), { reply_markup: streamMenu });
  });

  commandGroup.command("thinking", t("切换思考程度"), async (context) => {
    const chatId = context.chat.id;
    const supported = await menus.supportsThinkingForChat(chatId);
    if (!supported) {
      await context.reply(t("当前模型不支持思考等级"));
      return;
    }
    await menus.ensureThinkingForChat(chatId);
    await context.reply(t("🧠 思考程度:"), { reply_markup: thinkingMenu });
  });

  const cronFeatures = createCronFeatures({
    bot,
    botIndex,
    botKey,
    pool,
    cron,
    commandGroup,
    maxResponseLength,
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

  function getMessageThreadId(context: BotContext): number | undefined {
    const raw = Number((context.message as any)?.message_thread_id);
    if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
    return raw;
  }

  function shouldUseDraftStreaming(context: BotContext): boolean {
    const chat = context.chat as any;
    if (!chat) return false;
    // Bot API currently supports draft streaming for private chats.
    return chat.type === "private";
  }

  async function supportsImagesForChat(
    chatId: number,
    session: ReturnType<AgentPool["get"]>,
  ): Promise<boolean> {
    const cached = imageSupportCache.get(chatId);
    const now = Date.now();
    if (cached && now - cached.at < 30_000) return cached.value;

    let value = true;
    try {
      const st = await session.getState();
      const model = (st as any)?.model;
      let parsed = parseModelImageSupport(model);

      if (typeof parsed !== "boolean" && model?.provider && model?.id) {
        try {
          const models = await session.getAvailableModels();
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
    context: BotContext,
    status: { delete?: () => Promise<unknown>; editText: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
    text: string,
  ): Promise<void> => {
    const safe = truncate(text, 3500);
    await status.delete?.().catch(() => {});
    await context.reply(safe).catch(async () => {
      try {
        await status.editText(safe);
      } catch {
        // ignore final fallback failure
      }
    });
  };

  const runPromptRequest = async (
    context: BotContext,
    session: ReturnType<AgentPool["get"]>,
    makePayload: (opts: PromptBuildOptions) => Promise<PromptPayload>,
  ): Promise<void> => {
    const ahead = session.queuedCount + (session.running ? 1 : 0);
    const chatId = context.chat?.id ?? 0;
    const useStream = menus.isStreamEnabled(chatId);
    const useDraftStream = useStream && shouldUseDraftStreaming(context);

    const initialStatus = ahead > 0
      ? t("⏳ 排队中（前方 {count} 条）...", { count: ahead })
      : t("⏳ 思考中...");
    const status = !useStream
      ? await context.reply(initialStatus)
      : null;

    let streamedText = "";
    context.chatAction = "typing";

    const promptTracker = createActivePromptTracker(chatId, useStream ? "stream" : "non-stream");
    const onStart = () => {
      promptTracker.onStart();
      if (!status || ahead <= 0) return;
      void status.editText(t("⏳ 思考中...")).catch(() => {});
    };

    try {
      const supportsImages = await supportsImagesForChat(chatId, session);
      const { message, images } = await makePayload({ supportsImages });
      const promptMessage = message;

      if (useStream) {
        const stream = useDraftStream
          ? createDraftStreamUpdater(
            context.api,
            chatId,
            nextDraftId(chatId),
            getMessageThreadId(context),
            maxResponseLength,
            (err) => {
              log.warn(t("chat{chatId} sendRichMessageDraft 预览失败，已停用本次流式预览：{message}", {
                chatId,
                message: describeTelegramSendError(err),
              }));
            },
          )
          : createSilentStreamUpdater();

        const promptOnStart = () => {
          onStart();
          stream.onStart();
        };

        try {
          const result = await session.prompt(promptMessage, images, {
            onStart: promptOnStart,
            onTextDelta: (delta, fullText) => {
              streamedText = stripProtocolTags(fullText);
              stream.onTextDelta(delta, fullText);
            },
            onToolStart: stream.onToolStart,
            onToolError: stream.onToolError,
          });

          await stream.stopAndWait();
          const processed = await cronFeatures.applyToolDirectives(context, result.text);

          await sendReply(context, processed.text, result.tools, maxResponseLength, processed.warnings);
        } finally {
          await stream.stopAndWait();
        }

        return;
      }

      const result = await session.prompt(promptMessage, images, {
        onStart,
        onTextDelta: (_delta, fullText) => {
          streamedText = stripProtocolTags(fullText);
        },
      });
      await status?.delete().catch(() => {});
      const processed = await cronFeatures.applyToolDirectives(context, result.text);
      await sendReply(context, processed.text, result.tools, maxResponseLength, processed.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "aborted") {
        const abortDirective = abortDirectiveByPromptToken.get(promptTracker.token);
        if (abortDirective) {
          abortDirectiveByPromptToken.delete(promptTracker.token);
          await status?.delete().catch(() => {});

          const partial = stripProtocolTags(streamedText).trim();
          if (abortDirective.sendPartial && partial) {
            await sendPreparedReply(
              context,
              { body: partial, attachments: [], warnings: [] },
              maxResponseLength,
            ).catch(() => {});
          }

          if (abortDirective.showAbortNotice) {
            await context.reply(t("🛑 已中止")).catch(() => {});
          }
        } else if (consumeAbortNoticeSuppression(chatId)) {
          await status?.delete().catch(() => {});
        } else if (status) {
          await reportStatusOrReply(context, status, t("🛑 已中止"));
        } else {
          await context.reply(t("🛑 已中止")).catch(() => {});
        }
      } else if (useStream && streamedText.trim()) {
        const errLine = t("⚠️ 生成中断：{message}", { message: truncate(message, 300) });
        const merged = truncate(`${streamedText}\n\n${errLine}`, maxResponseLength);
        if (status) {
          await reportStatusOrReply(context, status, merged);
        } else {
          await context.reply(merged).catch(() => {});
        }
      } else {
        const errorText = t("❌ 错误：{message}", { message });
        if (status) {
          await reportStatusOrReply(context, status, errorText);
        } else {
          await context.reply(errorText).catch(() => {});
        }
      }
    } finally {
      promptTracker.finish();
      context.chatAction = null;
    }
  };

  // Text messages
  bot.on("message:text", async (context) => {
    const text = context.message.text;
    if (!text) return;
    if (text.startsWith("/")) return;

    if (await cronFeatures.consumePendingInput(context, text)) return;

    rememberReplyMessage(replyScopeKey(context), "user", context.message.message_id, text);
    rememberReferencedReply(context);

    const key = chatKey(botKey, context.chat.id);
    const session = pool.get(key);

    await runPromptRequest(context, session, async ({ supportsImages }) =>
      buildPromptPayloadWithReplyContext(context, text, config.token, supportsImages),
    );
  });

  // Photos
  bot.on("message:photo", async (context) => {
    const caption = context.message.caption || t("请描述这张图片");
    rememberReplyMessage(replyScopeKey(context), "user", context.message.message_id, caption);
    rememberReferencedReply(context);

    const key = chatKey(botKey, context.chat.id);
    const session = pool.get(key);

    await runPromptRequest(context, session, async ({ supportsImages }) => {
      const photos = context.message.photo;
      const current = photos[photos.length - 1];
      const image = await downloadImageByFileId(
        context,
        config.token,
        current.file_id,
        "image/jpeg",
        supportsImages,
      );
      const currentImages = image ? [image] : [];

      return buildPromptPayloadWithReplyContext(
        context,
        caption,
        config.token,
        supportsImages,
        currentImages,
      );
    });
  });

  // Generic files (documents)
  bot.on("message:document", async (context) => {
    const document = context.message.document;
    const baseText = context.message.caption || document.file_name || t("请处理这个文件");
    rememberReplyMessage(replyScopeKey(context), "user", context.message.message_id, baseText);
    rememberReferencedReply(context);

    const key = chatKey(botKey, context.chat.id);
    const session = pool.get(key);

    await runPromptRequest(context, session, async ({ supportsImages }) => {
      const loaded = await downloadInboundFileByFileId(
        context,
        config.token,
        document.file_id,
        String(document.mime_type || "application/octet-stream"),
        supportsImages,
      );

      const currentImages = loaded?.image ? [loaded] : [];
      const currentFilePaths = loaded ? [normalizePromptPath(loaded.localPath)] : [];

      return buildPromptPayloadWithReplyContext(
        context,
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

