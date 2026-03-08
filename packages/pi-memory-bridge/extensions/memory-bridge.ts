import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface BridgeContextResponse {
  contextText: string;
  selectedUris: string[];
  trace: string[] | null;
}

interface BridgeIngestResponse {
  accepted: boolean;
  queued: boolean;
  ingestId: string;
}

interface BridgeSearchResponse {
  nodes: Array<{ canonicalUri: string; familyUri: string; plane: string; temporalLevel: string; summary: string }>;
}

interface BridgeTraceResponse {
  node?: Record<string, unknown>;
  entities: unknown[];
  edges: unknown[];
}

interface BridgeForgetResponse {
  ok: boolean;
  deleted: number;
}

interface BridgePurgeScopeResponse {
  ok: boolean;
  deleted: number;
}

interface BridgeExportResponse {
  nodes: unknown[];
  entities: unknown[];
  edges: unknown[];
  rawTurns: unknown[];
}

interface BridgeIntegrityResponse {
  ok: boolean;
  checks: string[];
}

interface BridgeExportFileResponse {
  ok: boolean;
  filePath: string;
  nodes: number;
  entities: number;
  edges: number;
  rawTurns: number;
}

interface BridgeBackupResponse {
  ok: boolean;
  filePath: string;
}

interface BridgeRepairResponse {
  ok: boolean;
  scanned: number;
  repaired: number;
}

interface BridgeAddResponse {
  ok: boolean;
  canonicalUris: string[];
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : undefined;
}

function authHeaders(): Record<string, string> {
  const token = env("PI_MEMORY_BRIDGE_TOKEN");
  return token ? { authorization: `Bearer ${token}` } : {};
}

function basePayload() {
  const userIdRaw = env("PI_MEMORY_USER_ID");
  const userId = userIdRaw ? Number(userIdRaw) : undefined;
  return {
    botHash: env("PI_MEMORY_BOT_HASH") || "",
    botName: env("PI_MEMORY_BOT_NAME") || "",
    chatId: Number(env("PI_MEMORY_CHAT_ID") || 0),
    userId: Number.isSafeInteger(userId) ? userId : undefined,
    workspaceCwd: env("PI_MEMORY_WORKSPACE_CWD") || "",
    source: (env("PI_MEMORY_SOURCE") || "telegram") as "telegram" | "cron",
  };
}

function sessionPayload(ctx: { sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } }) {
  return {
    session: {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
    },
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text.trim());
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function roleOfMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : undefined;
}

function extractTurnMessages(event: AgentEndEvent): Array<{ role: "user" | "assistant"; content: string; timestamp: number }> {
  const out: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];
  for (const message of event.messages) {
    const role = roleOfMessage(message);
    if (role !== "user" && role !== "assistant") continue;
    const rec = message as Record<string, unknown>;
    const content = textFromContent(rec.content);
    if (!content) continue;
    const timestamp = typeof rec.timestamp === "number" ? rec.timestamp : Date.now();
    out.push({ role, content, timestamp });
  }
  return out;
}

async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse | undefined> {
  const baseUrl = env("PI_MEMORY_BRIDGE_URL");
  if (!baseUrl) return undefined;

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return undefined;
  return await response.json() as TResponse;
}

async function getHealth(): Promise<boolean> {
  const baseUrl = env("PI_MEMORY_BRIDGE_URL");
  if (!baseUrl) return false;
  const response = await fetch(`${baseUrl}/v1/health`, {
    headers: authHeaders(),
  });
  return response.ok;
}

function textToolResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text", text }],
    details: (details && typeof details === "object") ? details : {},
  };
}

export default function memoryBridge(pi: ExtensionAPI) {
  let lastSelectedMemoryUris: string[] = [];

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search long-term memory via Pi-Telegram memory core.",
    promptSnippet: "Use memory_search to search long-term memory when historical preferences, rules, or project context may help.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeSearchResponse>("/v1/memory/search", {
        ...basePayload(),
        prompt: params.query,
        limit: params.limit,
      });
      if (!response?.nodes?.length) {
        return textToolResult("No matching memories found.");
      }
      const lines = response.nodes.map((node, index) => `${index + 1}. [${node.plane}/${node.temporalLevel}] ${node.summary}\n   canonical=${node.canonicalUri}\n   family=${node.familyUri}`);
      return textToolResult(lines.join("\n\n"), { count: response.nodes.length });
    },
  });

  pi.registerTool({
    name: "memory_trace",
    label: "Memory Trace",
    description: "Trace a memory node by canonical URI.",
    parameters: Type.Object({
      canonicalUri: Type.String({ description: "Canonical URI of the memory node" }),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeTraceResponse>("/v1/memory/trace", {
        canonicalUri: params.canonicalUri,
      });
      if (!response?.node) {
        return textToolResult("Memory node not found.");
      }
      const node = response.node;
      const lines = [
        `canonical=${String(node.canonicalUri || params.canonicalUri)}`,
        `family=${String(node.familyUri || "")}`,
        `plane=${String(node.plane || "")}`,
        `level=${String(node.temporalLevel || "")}`,
        `summary=${String(node.summary || "")}`,
        `entities=${response.entities.length}`,
        `edges=${response.edges.length}`,
      ];
      return textToolResult(lines.join("\n"), { node, entities: response.entities, edges: response.edges });
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Delete a memory node or an entire memory family.",
    parameters: Type.Object({
      canonicalUri: Type.Optional(Type.String({ description: "Canonical URI to delete" })),
      familyUri: Type.Optional(Type.String({ description: "Family URI to delete" })),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeForgetResponse>("/v1/memory/forget", {
        canonicalUri: params.canonicalUri,
        familyUri: params.familyUri,
      });
      return textToolResult(`Deleted ${response?.deleted ?? 0} memory node(s).`, response ? { deleted: response.deleted } : {});
    },
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description: "Add an explicit memory entry through Pi-Telegram memory core.",
    parameters: Type.Object({
      text: Type.String({ description: "Memory text to store" }),
      summary: Type.Optional(Type.String({ description: "Optional compact summary" })),
      plane: Type.Optional(Type.Union([
        Type.Literal("episodic"),
        Type.Literal("profile"),
        Type.Literal("project"),
        Type.Literal("procedural"),
      ])),
      temporalLevel: Type.Optional(Type.Union([
        Type.Literal("T1"),
        Type.Literal("T2"),
        Type.Literal("T3"),
        Type.Literal("T4"),
        Type.Literal("T5"),
      ])),
      scopeKind: Type.Optional(Type.Union([
        Type.Literal("chat-local"),
        Type.Literal("user-global"),
        Type.Literal("workspace-global"),
      ])),
      importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeAddResponse>("/v1/memory/add", {
        ...basePayload(),
        ...params,
      });
      return textToolResult(
        response?.canonicalUris?.length
          ? `Added ${response.canonicalUris.length} memory node(s).\n${response.canonicalUris.join("\n")}`
          : "No memory was added.",
        response ? { canonicalUris: response.canonicalUris } : {},
      );
    },
  });

  pi.registerTool({
    name: "memory_export",
    label: "Memory Export",
    description: "Export memory snapshot metadata from Pi-Telegram memory core.",
    parameters: Type.Object({
      scopeKind: Type.Optional(Type.Union([
        Type.Literal("chat-local"),
        Type.Literal("user-global"),
        Type.Literal("workspace-global"),
        Type.Literal("system-global"),
      ])),
      scopeId: Type.Optional(Type.String({ description: "Optional scope id" })),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeExportResponse>("/v1/memory/export", params);
      return textToolResult(
        `nodes=${response?.nodes.length ?? 0}\nentities=${response?.entities.length ?? 0}\nedges=${response?.edges.length ?? 0}\nrawTurns=${response?.rawTurns.length ?? 0}`,
        response ?? {},
      );
    },
  });

  pi.registerTool({
    name: "memory_purge_scope",
    label: "Memory Purge Scope",
    description: "Delete all memory data under a specific scope.",
    parameters: Type.Object({
      scopeKind: Type.Union([
        Type.Literal("chat-local"),
        Type.Literal("user-global"),
        Type.Literal("workspace-global"),
        Type.Literal("system-global"),
      ]),
      scopeId: Type.String({ description: "Scope id" }),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgePurgeScopeResponse>("/v1/memory/purge-scope", params);
      return textToolResult(`Deleted ${response?.deleted ?? 0} record(s).`, response ? { deleted: response.deleted } : {});
    },
  });

  pi.registerTool({
    name: "memory_integrity",
    label: "Memory Integrity",
    description: "Run integrity checks against the Pi-Telegram memory store.",
    parameters: Type.Object({}),
    async execute() {
      const baseUrl = env("PI_MEMORY_BRIDGE_URL");
      if (!baseUrl) return textToolResult("Memory bridge URL is not configured.");
      const response = await fetch(`${baseUrl}/v1/memory/integrity`, { headers: authHeaders() });
      const json = response.ok ? await response.json() as BridgeIntegrityResponse : undefined;
      return textToolResult([`ok=${json?.ok ? "yes" : "no"}`, ...(json?.checks ?? [])].join("\n"), json ?? {});
    },
  });

  pi.registerTool({
    name: "memory_export_file",
    label: "Memory Export File",
    description: "Export memory snapshot to a JSON file.",
    parameters: Type.Object({
      scopeKind: Type.Optional(Type.Union([
        Type.Literal("chat-local"),
        Type.Literal("user-global"),
        Type.Literal("workspace-global"),
        Type.Literal("system-global"),
      ])),
      scopeId: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeExportFileResponse>("/v1/memory/export-file", params);
      return textToolResult(
        `ok=${response?.ok ? "yes" : "no"}\nfile=${response?.filePath || ""}\nnodes=${response?.nodes ?? 0}\nentities=${response?.entities ?? 0}\nedges=${response?.edges ?? 0}\nrawTurns=${response?.rawTurns ?? 0}`,
        response ?? {},
      );
    },
  });

  pi.registerTool({
    name: "memory_backup",
    label: "Memory Backup",
    description: "Create a SQLite backup of the memory store.",
    parameters: Type.Object({
      filePath: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeBackupResponse>("/v1/memory/backup", params);
      return textToolResult(`ok=${response?.ok ? "yes" : "no"}\nfile=${response?.filePath || ""}`, response ?? {});
    },
  });

  pi.registerTool({
    name: "memory_repair",
    label: "Memory Repair",
    description: "Retry failed memory graph/embedding artifact generation.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params) {
      const response = await postJson<BridgeRepairResponse>("/v1/memory/repair", {
        ...basePayload(),
        limit: params.limit,
      });
      return textToolResult(
        `ok=${response?.ok ? "yes" : "no"}\nscanned=${response?.scanned ?? 0}\nrepaired=${response?.repaired ?? 0}`,
        response ?? {},
      );
    },
  });

  pi.on("session_start", async () => {
    try {
      await getHealth();
    } catch {
      // ignore
    }
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    try {
      const maxChars = Number(env("PI_MEMORY_MAX_CONTEXT_CHARS") || 0) || undefined;
      const payload = {
        ...basePayload(),
        ...sessionPayload(ctx),
        prompt: event.prompt,
        scopes: {
          chat: env("PI_MEMORY_CHAT_SCOPE"),
          user: env("PI_MEMORY_USER_SCOPE"),
          workspace: env("PI_MEMORY_WORKSPACE_SCOPE"),
        },
        budget: maxChars ? { maxChars } : undefined,
      };
      const response = await postJson<BridgeContextResponse>("/v1/context", payload);
      lastSelectedMemoryUris = response?.selectedUris ?? [];
      if (!response?.contextText?.trim()) return;
      return {
        message: {
          customType: "pi-memory-context",
          content: response.contextText,
          display: false,
          details: response.trace ? { trace: response.trace, selectedUris: response.selectedUris } : undefined,
        },
      };
    } catch {
      return;
    }
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    try {
      const messages = extractTurnMessages(event);
      if (!messages.length) return;
      await postJson<BridgeIngestResponse>("/v1/ingest-turns", {
        ...basePayload(),
        ...sessionPayload(ctx),
        selectedMemoryUris: lastSelectedMemoryUris,
        messages,
      });
    } catch {
      // ignore
    }
  });

  const flush = async (reason: SessionBeforeSwitchEvent["reason"] | "shutdown", ctx: { sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } }) => {
    try {
      await postJson("/v1/flush", {
        ...basePayload(),
        ...sessionPayload(ctx),
        reason,
      });
    } catch {
      // ignore
    } finally {
      lastSelectedMemoryUris = [];
    }
  };

  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
    await flush(event.reason, ctx);
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    await flush("shutdown", ctx);
  });
}
