// src/telegram/format.ts — markdown → Telegram HTML
import MarkdownIt from "markdown-it";
import cjk from "markdown-it-cjk-friendly";
import sanitize from "sanitize-html";

// Render markdown first, then sanitize to Telegram-supported HTML subset
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
}).use(cjk);

const defaultValidateLink = md.validateLink.bind(md);
md.validateLink = (url: string) => {
  const normalized = url.trim().toLowerCase();
  if (
    !normalized.startsWith("http://")
    && !normalized.startsWith("https://")
    && !normalized.startsWith("tg://")
  ) {
    return false;
  }
  return defaultValidateLink(url);
};

// Make markdown output closer to Telegram HTML (avoid unsupported tags)
md.renderer.rules.softbreak = () => "\n";
md.renderer.rules.hardbreak = () => "\n";
md.renderer.rules.paragraph_open = () => "";
md.renderer.rules.paragraph_close = () => "\n\n";
md.renderer.rules.bullet_list_open = () => "";
md.renderer.rules.bullet_list_close = () => "\n";
md.renderer.rules.ordered_list_open = () => "";
md.renderer.rules.ordered_list_close = () => "\n";
md.renderer.rules.list_item_open = () => "• ";
md.renderer.rules.list_item_close = () => "\n";
md.renderer.rules.heading_open = () => "<b>";
md.renderer.rules.heading_close = () => "</b>\n";
md.renderer.rules.strong_open = () => "<b>";
md.renderer.rules.strong_close = () => "</b>";
md.renderer.rules.em_open = () => "<i>";
md.renderer.rules.em_close = () => "</i>";
md.renderer.rules.s_open = () => "<s>";
md.renderer.rules.s_close = () => "</s>";
md.renderer.rules.hr = () => "\n────────\n";

// Telegram Bot API HTML mode whitelist
const tgAllowed: sanitize.IOptions = {
  allowedTags: [
    "b", "strong",
    "i", "em",
    "u", "ins",
    "s", "strike", "del",
    "tg-spoiler",
    "a",
    "tg-emoji",
    "code",
    "pre",
    "blockquote",
  ],
  allowedAttributes: {
    a: ["href"],
    "tg-emoji": ["emoji-id"],
    code: ["class"],
    blockquote: ["expandable"],
  },
  allowedClasses: {
    code: [/^language-[a-z0-9_+-]+$/i],
  },
  allowedSchemesByTag: {
    a: ["http", "https", "tg"],
  },
  allowProtocolRelative: false,

  // Normalize equivalent tags and spoiler span form
  transformTags: {
    strong: "b",
    em: "i",
    ins: "u",
    del: "s",
    strike: "s",
    span: (_tagName, attribs) => {
      if (attribs.class === "tg-spoiler") {
        return { tagName: "tg-spoiler", attribs: {} };
      }
      // unsupported span -> discard wrapper
      return { tagName: "span", attribs: {} };
    },
    h1: "b", h2: "b", h3: "b", h4: "b", h5: "b", h6: "b",
  },

  disallowedTagsMode: "discard",
};

const plainAllowed: sanitize.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

function normalizeTelegramHtml(html: string): string {
  return (html.includes("\n\n\n")
    ? html.replace(/\n{3,}/g, "\n\n")
    : html)
    .trim();
}

function isSimpleSafeTelegramRawTag(rawTag: string): boolean {
  if (!rawTag || rawTag !== rawTag.trim()) return false;
  const tag = rawTag[0] === "/" ? rawTag.slice(1) : rawTag;

  switch (tag.toLowerCase()) {
    case "b":
    case "strong":
    case "i":
    case "em":
    case "u":
    case "ins":
    case "s":
    case "strike":
    case "del":
    case "tg-spoiler":
    case "code":
    case "pre":
    case "blockquote":
      return true;
    default:
      return false;
  }
}

function canSkipTelegramHtmlSanitize(text: string): boolean {
  if (text.includes("&")) return false;

  let open = text.indexOf("<");
  if (open < 0) return true;

  while (open >= 0) {
    const close = text.indexOf(">", open + 1);
    if (close < 0) return false;
    if (!isSimpleSafeTelegramRawTag(text.slice(open + 1, close))) return false;
    open = text.indexOf("<", close + 1);
  }

  return true;
}

export function mdToTgHtml(text: string): string {
  const source = text || "";
  const html = md.render(source);
  const safe = canSkipTelegramHtmlSanitize(source)
    ? normalizeTelegramHtml(html)
    : normalizeTelegramHtml(sanitize(html, tgAllowed));

  // Telegram accepts plain text too; avoid empty HTML payloads
  return safe || "(无回复)";
}

export function mdToPlainText(text: string): string {
  const html = md.render(text || "");
  const plain = sanitize(html, plainAllowed);
  const normalized = (plain.includes("\u00a0")
    ? plain.replace(/\u00a0/g, " ")
    : plain);
  const collapsed = normalized.includes("\n\n\n")
    ? normalized.replace(/\n{3,}/g, "\n\n")
    : normalized;

  return collapsed.trim() || "(无回复)";
}
