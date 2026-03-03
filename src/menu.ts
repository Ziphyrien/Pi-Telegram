// src/menu.ts — menu construction and per-chat menu state
import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { PiPool } from "./pool.js";
import type { PiModelInfo } from "./types.js";

export interface BotMenus<C extends Context> {
  modelMenu: Menu<C>;
  streamMenu: Menu<C>;
  thinkingMenu: Menu<C>;
  isStreamEnabled: (chatId: number) => boolean;
  refreshModelsForChat: (chatId: number) => Promise<PiModelInfo[]>;
  ensureThinkingForChat: (chatId: number) => Promise<string>;
  supportsThinkingForChat: (chatId: number) => Promise<boolean>;
  syncState: (chatId: number, state: Record<string, unknown>) => void;
}

export interface CreateBotMenusOptions {
  botIndex: number;
  botKey: string;
  pool: PiPool;
  outdatedMenuText?: string;
  initialStreamByChat?: Record<string, boolean>;
  onStreamModeChange?: (chatId: number, enabled: boolean) => Promise<void> | void;
}

export function createBotMenus<C extends Context>(opts: CreateBotMenusOptions): BotMenus<C> {
  const { botIndex, botKey, pool } = opts;
  const outdatedMenuText = opts.outdatedMenuText ?? "菜单已更新，请重试";

  const cachedModels = new Map<number, PiModelInfo[]>(); // chatId -> models
  const modelCacheAt = new Map<number, number>();        // chatId -> cache timestamp
  const activeModelId = new Map<number, string>();       // chatId -> provider:modelId
  const activeThinkingLevel = new Map<number, string>(); // chatId -> thinking level
  const streamEnabled = new Map<number, boolean>();      // chatId -> stream mode

  const MODEL_CACHE_TTL_MS = 30_000;

  for (const [chatIdStr, enabled] of Object.entries(opts.initialStreamByChat ?? {})) {
    const chatId = Number(chatIdStr);
    if (!Number.isFinite(chatId)) continue;
    streamEnabled.set(chatId, Boolean(enabled));
  }

  const modelsLoading = new Map<number, Promise<PiModelInfo[]>>();
  const thinkingLoading = new Map<number, Promise<string>>();

  const isStreamEnabled = (chatId: number): boolean => streamEnabled.get(chatId) ?? true;

  async function setStreamEnabled(chatId: number, enabled: boolean): Promise<void> {
    const prev = streamEnabled.get(chatId);
    streamEnabled.set(chatId, enabled);

    try {
      await opts.onStreamModeChange?.(chatId, enabled);
    } catch (err) {
      if (prev === undefined) {
        streamEnabled.delete(chatId);
      } else {
        streamEnabled.set(chatId, prev);
      }
      throw err;
    }
  }

  function chatKey(chatId: number): string {
    return `bot${botKey}_chat${chatId}`;
  }

  function modelKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  function thinkingLabel(level: string): string {
    switch (level) {
      case "off": return "关闭 (off)";
      case "minimal": return "极低 (minimal)";
      case "low": return "低 (low)";
      case "medium": return "中 (medium)";
      case "high": return "高 (high)";
      case "xhigh": return "极高 (xhigh)";
      default: return level;
    }
  }

  function syncState(chatId: number, state: Record<string, unknown>): void {
    const s = state as any;
    const m = s.model;
    if (m?.provider && m?.id) {
      activeModelId.set(chatId, modelKey(String(m.provider), String(m.id)));
    }
    if (s.thinkingLevel) {
      activeThinkingLevel.set(chatId, String(s.thinkingLevel));
    }
  }

  async function refreshModelsForChat(chatId: number): Promise<PiModelInfo[]> {
    const inst = pool.get(chatKey(chatId));
    const models = await inst.getAvailableModels();
    cachedModels.set(chatId, models);
    modelCacheAt.set(chatId, Date.now());

    const providers = [...new Set(models.map((m) => m.provider))];
    for (const provider of providers) ensureProviderSub(provider);

    try {
      const st = await inst.getState();
      syncState(chatId, st);
    } catch { /* ignore state sync failures */ }

    return models;
  }

  async function ensureModelsForChat(chatId: number, force = false): Promise<PiModelInfo[]> {
    const cached = cachedModels.get(chatId);
    const cachedAt = modelCacheAt.get(chatId) ?? 0;
    const isFresh = Date.now() - cachedAt < MODEL_CACHE_TTL_MS;
    if (!force && cached !== undefined && isFresh) return cached;

    const loading = modelsLoading.get(chatId);
    if (loading) return loading;

    const task = refreshModelsForChat(chatId)
      .catch(() => [])
      .finally(() => {
        modelsLoading.delete(chatId);
      });
    modelsLoading.set(chatId, task);
    return task;
  }

  async function refreshThinkingForChat(chatId: number): Promise<string> {
    const inst = pool.get(chatKey(chatId));
    const st = await inst.getState();
    syncState(chatId, st);
    const level = st.thinkingLevel ? String(st.thinkingLevel) : "";
    if (level) activeThinkingLevel.set(chatId, level);
    return level;
  }

  async function ensureThinkingForChat(chatId: number): Promise<string> {
    const cached = activeThinkingLevel.get(chatId);
    if (cached) return cached;

    const loading = thinkingLoading.get(chatId);
    if (loading) return loading;

    const task = refreshThinkingForChat(chatId)
      .catch(() => "")
      .finally(() => {
        thinkingLoading.delete(chatId);
      });
    thinkingLoading.set(chatId, task);
    return task;
  }

  async function supportsThinkingForChat(chatId: number): Promise<boolean> {
    const inst = pool.get(chatKey(chatId));

    try {
      const st = await inst.getState();
      syncState(chatId, st);
      const m = (st as any).model;
      if (typeof m?.reasoning === "boolean") {
        return m.reasoning;
      }
    } catch { /* ignore */ }

    const current = activeModelId.get(chatId);
    if (!current) return true;

    const models = await ensureModelsForChat(chatId);
    const selected = models.find((m) => modelKey(m.provider, m.id) === current);
    return selected?.reasoning ?? true;
  }

  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

  const modelMenu = new Menu<C>(`model-menu-${botIndex}`, {
    onMenuOutdated: outdatedMenuText,
    fingerprint: async (ctx) => {
      const chatId = ctx.chat?.id ?? 0;
      const models = await ensureModelsForChat(chatId);
      const providers = [...new Set(models.map((m) => m.provider))].sort();
      return `providers:${providers.join("|")}`;
    },
  })
    .dynamic(async (ctx, range) => {
      const chatId = ctx.chat?.id ?? 0;
      const models = await ensureModelsForChat(chatId);
      const providers = [...new Set(models.map((m) => m.provider))];

      range.text("🔄 刷新模型列表", async (ctx) => {
        const cid = ctx.chat?.id ?? 0;
        try {
          await refreshModelsForChat(cid);
          try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
          await ctx.answerCallbackQuery({ text: "模型列表已刷新" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.answerCallbackQuery({ text: `❌ 刷新失败：${msg}`.slice(0, 180) });
        }
      }).row();

      if (!providers.length) {
        range.text("⚠️ 无可用模型（pi 未启动？）", (ctx) =>
          ctx.answerCallbackQuery({ text: "请先发一条消息启动 pi" }),
        );
        return;
      }

      for (const provider of providers) {
        ensureProviderSub(provider);
        const subId = `models-${botIndex}-${provider}`;
        range.submenu(provider, subId, (ctx) => ctx.answerCallbackQuery()).row();
      }
    });

  const registeredSubs = new Set<string>();

  function ensureProviderSub(provider: string): void {
    const subId = `models-${botIndex}-${provider}`;
    if (registeredSubs.has(subId)) return;
    registeredSubs.add(subId);

    const sub = new Menu<C>(subId, {
      onMenuOutdated: outdatedMenuText,
      fingerprint: async (ctx) => {
        const chatId = ctx.chat?.id ?? 0;
        const models = (await ensureModelsForChat(chatId))
          .filter((m) => m.provider === provider)
          .map((m) => `${m.id}:${m.name}`)
          .join("|");
        const current = activeModelId.get(chatId) ?? "";
        return `provider:${provider}|models:${models}|current:${current}`;
      },
    })
      .dynamic(async (ctx, range) => {
        const chatId = ctx.chat?.id ?? 0;
        const models = await ensureModelsForChat(chatId);
        const current = activeModelId.get(chatId);

        range.text("🔄 刷新", async (ctx) => {
          const cid = ctx.chat?.id ?? 0;
          try {
            await refreshModelsForChat(cid);
            try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
            await ctx.answerCallbackQuery({ text: "已刷新" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.answerCallbackQuery({ text: `❌ 刷新失败：${msg}`.slice(0, 180) });
          }
        }).row();

        for (const mo of models) {
          if (mo.provider !== provider) continue;
          const keyOfModel = modelKey(mo.provider, mo.id);
          const check = current === keyOfModel ? "✅ " : "";
          const reasoning = mo.reasoning ? " · 🧠" : "";
          range.text(`${check}${mo.name}${reasoning}`, async (ctx) => {
            const cid = ctx.chat?.id ?? 0;
            const currentKey = activeModelId.get(cid);
            if (currentKey === keyOfModel) {
              await ctx.answerCallbackQuery({ text: `已是当前模型：${mo.name}` });
              return;
            }

            try {
              const inst = pool.get(chatKey(cid));
              await inst.rpcSetModel(mo.provider, mo.id);
              activeModelId.set(cid, keyOfModel);
              try { await refreshThinkingForChat(cid); } catch { /* ignore */ }
            } catch (err) {
              await ctx.answerCallbackQuery({ text: `❌ ${(err as Error).message}` });
              return;
            }

            try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
            await ctx.answerCallbackQuery({ text: `✅ 已切换：${mo.name}` });
          }).row();
        }
        range.back("⬅️ 返回", (ctx) => ctx.answerCallbackQuery());
      });

    modelMenu.register(sub);
  }

  const streamMenu = new Menu<C>(`stream-menu-${botIndex}`, {
    onMenuOutdated: outdatedMenuText,
    fingerprint: (ctx) => {
      const chatId = ctx.chat?.id ?? 0;
      return isStreamEnabled(chatId) ? "stream:1" : "stream:0";
    },
  })
    .dynamic((ctx, range) => {
      const chatId = ctx.chat?.id ?? 0;
      const enabled = isStreamEnabled(chatId);

      range.text(`${enabled ? "✅ " : ""}流式输出`, async (ctx) => {
        const cid = ctx.chat?.id ?? 0;
        if (isStreamEnabled(cid)) {
          await ctx.answerCallbackQuery({ text: "当前已是流式输出" });
          return;
        }

        try {
          await setStreamEnabled(cid, true);
          try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
          await ctx.answerCallbackQuery({ text: "已切换为流式输出" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.answerCallbackQuery({ text: `❌ 保存失败：${msg}`.slice(0, 180) });
        }
      }).row();

      range.text(`${!enabled ? "✅ " : ""}非流式输出`, async (ctx) => {
        const cid = ctx.chat?.id ?? 0;
        if (!isStreamEnabled(cid)) {
          await ctx.answerCallbackQuery({ text: "当前已是非流式输出" });
          return;
        }

        try {
          await setStreamEnabled(cid, false);
          try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
          await ctx.answerCallbackQuery({ text: "已切换为非流式输出" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.answerCallbackQuery({ text: `❌ 保存失败：${msg}`.slice(0, 180) });
        }
      });
    });

  const thinkingMenu = new Menu<C>(`thinking-menu-${botIndex}`, {
    onMenuOutdated: outdatedMenuText,
    fingerprint: async (ctx) => {
      const chatId = ctx.chat?.id ?? 0;
      const supported = await supportsThinkingForChat(chatId);
      const current = supported ? await ensureThinkingForChat(chatId) : "";
      return `thinking:supported=${supported ? 1 : 0}:current=${current}`;
    },
  })
    .dynamic(async (ctx, range) => {
      const chatId = ctx.chat?.id ?? 0;
      const supported = await supportsThinkingForChat(chatId);
      if (!supported) {
        range.text("当前模型不支持思考等级", (ctx) =>
          ctx.answerCallbackQuery({ text: "当前模型不支持思考等级" }),
        );
        return;
      }

      const current = await ensureThinkingForChat(chatId);

      range.text("🔄 刷新状态", async (ctx) => {
        const cid = ctx.chat?.id ?? 0;
        try {
          await refreshThinkingForChat(cid);
          try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
          await ctx.answerCallbackQuery({ text: "思考状态已刷新" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.answerCallbackQuery({ text: `❌ 刷新失败：${msg}`.slice(0, 180) });
        }
      }).row();

      for (const level of thinkingLevels) {
        const check = current === level ? "✅ " : "";
        range.text(`${check}${thinkingLabel(level)}`, async (ctx) => {
          const cid = ctx.chat?.id ?? 0;
          const now = activeThinkingLevel.get(cid) ?? "";
          if (now === level) {
            await ctx.answerCallbackQuery({ text: `当前已是 ${thinkingLabel(level)}` });
            return;
          }

          const inst = pool.get(chatKey(cid));
          try {
            await inst.rpcSetThinkingLevel(level);
            activeThinkingLevel.set(cid, level);
            try { ctx.menu.update(); } catch { /* ignore idempotent menu update */ }
            await ctx.answerCallbackQuery({ text: `✅ 已切换为 ${thinkingLabel(level)}` });
          } catch (err) {
            await ctx.answerCallbackQuery({ text: `❌ ${(err as Error).message}` });
          }
        });

        if (level === "minimal" || level === "medium" || level === "xhigh") {
          range.row();
        }
      }
    });

  return {
    modelMenu,
    streamMenu,
    thinkingMenu,
    isStreamEnabled,
    refreshModelsForChat,
    ensureThinkingForChat,
    supportsThinkingForChat,
    syncState,
  };
}
