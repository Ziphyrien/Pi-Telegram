import type { PiSessionStats } from "../pi/types.js";

interface CronStatusSummary {
  enabled: boolean;
  totalJobs: number;
  enabledJobs: number;
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
  const percent = typeof usage.percent === "number"
    ? ` (${usage.percent.toFixed(usage.percent >= 10 || Number.isInteger(usage.percent) ? 0 : 1)}%)`
    : "";

  return `📦 上下文占用: ${used} / ${total}${percent}`;
}

export function buildStatusLines(snapshot: BotStatusSnapshot): string[] {
  const lines: Array<string | undefined> = [
    `${snapshot.alive ? "✅ 运行中" : "💤 未启动"} | ${snapshot.processing ? "⏳ 处理中" : "🟢 空闲"}`,
    snapshot.providerLabel ? `🏢 供应商: ${snapshot.providerLabel}` : undefined,
    `🤖 模型: ${snapshot.modelLabel}`,
    `⚙️ 输出: ${snapshot.streamEnabled ? "流式" : "非流式"}`,
    snapshot.thinkingLabel ? `🧠 思考: ${snapshot.thinkingLabel}` : undefined,
    snapshot.sessionLabel ? `🗂 会话: ${snapshot.sessionLabel}` : undefined,
    typeof snapshot.cost === "number" && snapshot.cost > 0 ? `💰 花费: $${formatCost(snapshot.cost)}` : undefined,
    formatContextUsage(snapshot.contextUsage),
    `📊 活跃: ${snapshot.activeCount}`,
    `⏰ 定时: ${snapshot.cron.enabled ? "开启" : "关闭"} | 任务 ${snapshot.cron.totalJobs}（启用 ${snapshot.cron.enabledJobs}）`,
  ];

  return lines.filter((line): line is string => Boolean(line));
}
