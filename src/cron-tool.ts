// src/cron-tool.ts — parse AI cron directives (<tg-cron .../>)

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

const TAG_RE = /<tg-cron\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tg-cron>)/gi;

export function extractTgCronDirectives(input: string): CronDirectiveExtraction {
  const directives: TgCronDirective[] = [];
  const warnings: string[] = [];

  let last = 0;
  let clean = "";
  let m: RegExpExecArray | null;

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(input)) !== null) {
    clean += input.slice(last, m.index);
    last = TAG_RE.lastIndex;

    if (directives.length >= 8) {
      warnings.push("tg-cron 指令过多，仅处理前 8 条");
      continue;
    }

    const attrs = parseAttrs(m[1] ?? "");
    const body = trimEdgeNewlines(m[2] ?? "");

    const built = buildDirective(attrs, body, warnings);
    if (built) directives.push(built);
  }

  clean += input.slice(last);

  return {
    text: collapseGaps(clean).trim(),
    directives,
    warnings,
  };
}

function buildDirective(
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

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw)) !== null) {
    attrs[m[1].toLowerCase().replace(/-/g, "_")] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

function trimEdgeNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

function collapseGaps(s: string): string {
  return s
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}
