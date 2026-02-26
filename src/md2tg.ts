// src/md2tg.ts — markdown → Telegram HTML
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

export function mdToTgHtml(text: string): string {
  const html = md.render(text || "");
  const safe = sanitize(html, tgAllowed)
    // normalize excessive blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Telegram accepts plain text too; avoid empty HTML payloads
  return safe || "(无回复)";
}

export function mdToPlainText(text: string): string {
  const html = md.render(text || "");
  const plain = sanitize(html, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  })
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return plain || "(无回复)";
}
