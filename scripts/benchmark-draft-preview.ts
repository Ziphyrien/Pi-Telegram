import { performance } from "node:perf_hooks";
import { createDraftPreviewModel } from "../src/telegram/create-bot.ts";

type Scenario = {
  name: string;
  renderEvery: number;
  updates: string[];
  toolEvents: Array<{ index: number; name?: string; error?: boolean }>;
};

const MAX_LEN = 3200;
const SAMPLE_COUNT = envInt("DRAFT_PREVIEW_SAMPLES", 9);
const HTML_CYCLES = envInt("DRAFT_PREVIEW_HTML_CYCLES", 120);
const PLAIN_CYCLES = envInt("DRAFT_PREVIEW_PLAIN_CYCLES", 36);
const WARMUP_ROUNDS = envInt("DRAFT_PREVIEW_WARMUPS", 2);

const CHUNK_PATTERN = [14, 7, 19, 5, 23, 11, 29, 13, 17, 9, 31];
const scenarios = buildScenarios();
let blackhole = 0;

for (let i = 0; i < WARMUP_ROUNDS; i += 1) {
  runPhase(true, 12);
  runPhase(false, 4);
}

const samples = Array.from({ length: SAMPLE_COUNT }, () => {
  const html = runPhase(true, HTML_CYCLES);
  const plain = runPhase(false, PLAIN_CYCLES);
  return {
    totalMs: html.ms + plain.ms,
    htmlMs: html.ms,
    plainMs: plain.ms,
    renderCount: html.renderCount + plain.renderCount,
  };
});

const totals = samples.map((x) => x.totalMs);
const htmlTotals = samples.map((x) => x.htmlMs);
const plainTotals = samples.map((x) => x.plainMs);

console.log(`METRIC draft_preview_ms=${median(totals).toFixed(3)}`);
console.log(`METRIC draft_preview_html_ms=${median(htmlTotals).toFixed(3)}`);
console.log(`METRIC draft_preview_plain_ms=${median(plainTotals).toFixed(3)}`);
console.log(`METRIC draft_preview_p90_ms=${quantile(totals, 0.9).toFixed(3)}`);
console.log(`METRIC draft_preview_renders=${Math.round(median(samples.map((x) => x.renderCount)))}`);
console.log(`CHECKSUM ${blackhole}`);

function runPhase(supportsHtml: boolean, cycles: number): { ms: number; renderCount: number } {
  const startedAt = performance.now();
  let renderCount = 0;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const scenario of scenarios) {
      const model = createDraftPreviewModel(MAX_LEN);
      let nextToolEvent = 0;

      for (let i = 0; i < scenario.updates.length; i += 1) {
        while (nextToolEvent < scenario.toolEvents.length && scenario.toolEvents[nextToolEvent].index === i) {
          const event = scenario.toolEvents[nextToolEvent];
          model.onToolStart(event.name);
          if (event.error) model.onToolError();
          nextToolEvent += 1;
        }

        const fullText = scenario.updates[i];
        model.onTextDelta("", fullText);

        if ((i + 1) % scenario.renderEvery === 0) {
          const rendered = model.render(supportsHtml);
          blackhole ^= consumeRendered(rendered);
          renderCount += 1;
        }
      }

      const rendered = model.render(supportsHtml);
      blackhole ^= consumeRendered(rendered);
      renderCount += 1;
    }
  }

  return { ms: performance.now() - startedAt, renderCount };
}

function consumeRendered(rendered: ReturnType<ReturnType<typeof createDraftPreviewModel>["render"]>): number {
  if (!rendered) return 17;
  return rendered.draftText.length ^ rendered.renderKey.length ^ (rendered.parseMode === "HTML" ? 97 : 13);
}

function buildScenarios(): Scenario[] {
  return [
    makeScenario(
      "markdown-heavy",
      6,
      `### Draft preview plan\n\nWe are **streaming** a reply with _emphasis_, __extra markers__, \`inline code\`, and a [reference link](https://example.com/docs?q=preview).\n\n- first bullet with 中文 mixed in\n- second bullet with \`escaped\` code and ~~strike~~ text\n- third bullet with a nested snippet: <b>already-html</b>\n\n> The preview should keep the latest context while Pi is still writing.\n\n\n\n\n\n\`\`\`ts\nconst preview = buildPreview({ mode: \"stream\", safe: true });\nconsole.log(preview.slice(-120));\n\`\`\`\n\n<tg-attachment kind=\"document\" label=\"plan.md\">ignore me</tg-attachment>\nThe stream keeps adding details, caveats, and markdown markers so the tail keeps shifting.`,
      [
        { index: 8, name: "read_wiki" },
        { index: 24, name: "tavily_search" },
        { index: 37, name: "tavily_extract", error: true },
      ],
    ),
    makeScenario(
      "tool-then-answer",
      5,
      `Tool summary:\n<tg-reply to=\"self\" message_id=\"42\">ignore reply directive</tg-reply>\n\n1. Inspect state\n2. Patch formatter\n3. Re-run benchmark\n\nFinal answer starts here with **bold**, _italics_, and a fenced block.\n\n\`\`\`json\n{\n  \"status\": \"ok\",\n  \"notes\": [\"fast\", \"stable\", \"html\"]\n}\n\`\`\`\n\nThe draft also includes dangling tags like <tg-cron action=\"add\" expr=\"0 9 * * *\"` +
        ` while streaming, plus more text afterwards to force repeated tail truncation across updates.`,
      [
        { index: 3, name: "resolve_context" },
        { index: 15, name: "apply_patch" },
        { index: 28, name: "npm_run_build" },
      ],
    ),
    makeScenario(
      "long-tail",
      4,
      `The tail-focused preview should prefer the newest material when the message exceeds the safe limit. ` +
        `This paragraph is intentionally long and repetitive so the benchmark keeps walking over markdown syntax, ` +
        `links like [perf note](https://example.org/perf), inline code such as \`draft_preview_ms\`, and ` +
        `mixed language content：保持预览稳定，同时不要丢失工具行。\n\n` +
        Array.from({ length: 24 }, (_, i) => `- update ${i + 1}: **token burst** with extra commentary, HTML <i>tag</i>, and <tg-attachment kind=\"photo\">x</tg-attachment>.`).join("\n"),
      [
        { index: 6, name: "stream_reply" },
        { index: 12, name: "format_markdown" },
        { index: 30, name: "send_draft" },
      ],
    ),
  ];
}

function makeScenario(
  name: string,
  renderEvery: number,
  text: string,
  toolEvents: Array<{ index: number; name?: string; error?: boolean }>,
): Scenario {
  const chunks = chunkText(text, CHUNK_PATTERN);
  let full = "";
  const updates = chunks.map((chunk) => {
    full += chunk;
    return full;
  });
  return { name, renderEvery, updates, toolEvents };
}

function chunkText(text: string, pattern: number[]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const size = pattern[index % pattern.length];
    chunks.push(text.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
