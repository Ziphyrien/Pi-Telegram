// src/log.ts — colored logger, reuses pi's Theme system
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piEntryJs = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRoot = resolve(dirname(piEntryJs), "..");
const themeJs = resolve(piRoot, "dist", "modes", "interactive", "theme", "theme.js");

const mod = await import(pathToFileURL(themeJs).href);
mod.initTheme("dark");

const t = mod.theme as {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

const fg = (c: string, s: string) => t.fg(c, s);
const bold = (s: string) => t.bold(s);
const ts = () => fg("muted", new Date().toLocaleTimeString("en-GB"));

// ── Keyword highlighting using pi theme colors ──

const hlRules: [RegExp, string][] = [
  [/"[^"]*"/g,                                      "accent"],
  [/\b\d+(\.\d+)?\b/g,                             "warning"],
  [/\b(true|false)\b/g,                            "borderAccent"],
  [/\b(spawned|started|running|stopped)\b/gi,       "success"],
  [/\b(exited|stopping|reaping|error|failed)\b/gi,  "error"],
  [/\b(continue|abort|idle|alive|dead|fresh)\b/gi,  "borderAccent"],
  [/\bbot[a-f0-9]+_chat\d+\b/g,                    "border"],
  [/\([^)]+\)/g,                                    "dim"],
];

export interface LogTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export function highlightLogMessage(msg: string, theme: Pick<LogTheme, "fg"> = { fg }): string {
  const taken = new Uint8Array(msg.length);
  const ins: { p: number; e: number; c: string }[] = [];
  for (const [re, c] of hlRules) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(msg)) !== null) {
      const p = m.index, e = p + m[0].length;
      let skip = false;
      for (let i = p; i < e; i++) if (taken[i]) { skip = true; break; }
      if (skip) continue;
      for (let i = p; i < e; i++) taken[i] = 1;
      ins.push({ p, e, c });
    }
  }
  if (!ins.length) return msg;
  ins.sort((a, b) => b.p - a.p);
  let r = msg;
  for (const { p, e, c } of ins) r = r.slice(0, p) + theme.fg(c, r.slice(p, e)) + r.slice(e);
  return r;
}

export function formatLogLine(
  tag: string,
  msg: string,
  color: string,
  theme: LogTheme = { fg, bold },
  timestamp = ts(),
): string {
  return `${timestamp} ${theme.bold(theme.fg(color, tag))} ${highlightLogMessage(msg, theme)}`;
}

export const log = {
  boot:     (msg: string) => console.log(formatLogLine("[boot]", msg, "success")),
  pool:     (msg: string) => console.log(formatLogLine("[pool]", msg, "borderAccent")),
  bot:      (i: number, msg: string) => console.log(formatLogLine(`[bot${i}]`, msg, "border")),
  warn:     (msg: string) => console.warn(formatLogLine("[warn]", msg, "warning")),
  error:    (tag: string, msg: string) => console.error(formatLogLine(`[${tag}]`, msg, "error")),
  shutdown: (msg: string) => console.log(formatLogLine("[shutdown]", msg, "warning")),
};
