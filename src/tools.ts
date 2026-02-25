// src/tools.ts — AI tool registration & prompt wrapping

export interface AiToolDefinition {
  name: string;
  instructions: string;
}

export class AiToolRegistry {
  private readonly tools: AiToolDefinition[] = [];

  register(tool: AiToolDefinition): this {
    this.tools.push(tool);
    return this;
  }

  renderInstructions(): string {
    if (!this.tools.length) return "";
    const blocks = this.tools.map((t, i) => `# 工具 ${i + 1}: ${t.name}\n${t.instructions}`);
    return [
      "你可以使用以下桥接工具协议。仅当确实需要时使用。",
      ...blocks,
      "如果无需调用工具，直接正常回答。",
    ].join("\n\n");
  }
}

const telegramAttachmentTool: AiToolDefinition = {
  name: "tg-attachment",
  instructions: [
    "当你需要让 Telegram 发送附件/媒体时，在回复中输出 <tg-attachment> 标签。",
    "支持来源：file_id、URL、本地路径 path、上传内容（encoding=base64|text）。",
    "支持类型 as：photo | document | video | audio | animation | voice | video_note | sticker。",
    "不要把标签包在 markdown 代码块里。",
    "URL/file_id/path 可用自闭合标签。",
    "上传内容用成对标签，建议带 filename。",
    "本地路径是指运行 Pi-Telegram 的服务器本机路径，不是用户手机路径。",
    "示例1（file_id）：<tg-attachment as=\"photo\" file_id=\"AgAC...\" />",
    "示例2（URL）：<tg-attachment as=\"document\" url=\"https://example.com/a.pdf\" />",
    "示例3（本地路径）：<tg-attachment as=\"document\" path=\"C:/data/report.pdf\" />",
    "示例4（上传文本）：<tg-attachment as=\"document\" filename=\"note.txt\" encoding=\"text\">hello</tg-attachment>",
    "示例5（上传二进制）：<tg-attachment as=\"video\" filename=\"clip.mp4\" encoding=\"base64\">...</tg-attachment>",
  ].join("\n"),
};

const telegramReplyTool: AiToolDefinition = {
  name: "tg-reply",
  instructions: [
    "当你要针对某条历史消息（可来自用户或你自己）进行回复时，输出 <tg-reply ... /> 标签。",
    "你可以回复整条消息，也可以只引用其中一段（quote）。",
    "常用属性：",
    "- from: any | user | self（默认 any）",
    "- contains: 用于定位目标消息（目标消息文本需包含这段）",
    "- quote: 需要引用的子串（可选，不填则可只按消息回复）",
    "- message_id: 直接按消息 ID 回复（可选，优先级高）",
    "示例1：<tg-reply from=\"user\" contains=\"这个方案不安全\" quote=\"不安全\" />",
    "示例2：<tg-reply from=\"self\" contains=\"我上一条的结论\" />",
    "示例3：<tg-reply message_id=\"1234\" quote=\"关键段落\" />",
    "tg-reply 标签可与正文、tg-attachment 同时出现。",
  ].join("\n"),
};

const defaultRegistry = new AiToolRegistry()
  .register(telegramReplyTool)
  .register(telegramAttachmentTool);

export function buildPromptWithRegisteredTools(userMessage: string): string {
  const toolInstructions = defaultRegistry.renderInstructions();
  const body = userMessage.trim();
  if (!toolInstructions) return body;

  return [
    toolInstructions,
    "# 用户请求",
    body,
  ].join("\n\n");
}
