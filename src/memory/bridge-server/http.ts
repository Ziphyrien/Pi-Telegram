// src/memory/bridge-server/http.ts — local bridge API for pi-memory bridge extension
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type {
  MemoryBridgeAddRequest,
  MemoryBridgeContextRequest,
  MemoryBridgeFlushRequest,
  MemoryBridgeHealthResponse,
  MemoryBridgeIngestTurnsRequest,
  MemoryBridgeSearchRequest,
  MemoryBridgeTraceRequest,
  MemoryBridgeForgetRequest,
  MemoryBridgePurgeScopeRequest,
  MemoryBridgeExportRequest,
  MemoryBridgeExportFileRequest,
  MemoryBridgeBackupRequest,
  MemoryBridgeRepairRequest,
} from "../contracts.js";
import type { MemoryService } from "../service.js";

export interface MemoryBridgeServerHandle {
  token: string;
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StartMemoryBridgeServerOptions {
  appVersion: string;
  bridgeProtocolVersion: number;
  host?: string;
  port?: number;
}

function json(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return (text ? JSON.parse(text) : {}) as T;
}

function createAuthGuard(token: string) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const header = String(req.headers.authorization || "");
    if (header === `Bearer ${token}`) return true;
    json(res, 401, { ok: false, error: "unauthorized" });
    return false;
  };
}

export async function startMemoryBridgeServer(
  service: MemoryService,
  options: StartMemoryBridgeServerOptions,
): Promise<MemoryBridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const token = randomBytes(24).toString("hex");
  const auth = createAuthGuard(token);

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        json(res, 404, { ok: false, error: "not_found" });
        return;
      }

      if (req.method === "GET" && req.url === "/v1/health") {
        if (!auth(req, res)) return;
        const data: MemoryBridgeHealthResponse = {
          ok: true,
          service: "pi-memory-core",
          appVersion: options.appVersion,
          bridgeProtocolVersion: options.bridgeProtocolVersion,
        };
        json(res, 200, data);
        return;
      }

      if (req.method === "POST" && req.url === "/v1/context") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeContextRequest>(req);
        json(res, 200, await service.handleBridgeContext(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/ingest-turns") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeIngestTurnsRequest>(req);
        json(res, 200, service.handleBridgeIngestTurns(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/flush") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeFlushRequest>(req);
        json(res, 200, await service.handleBridgeFlush(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/search") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeSearchRequest>(req);
        json(res, 200, await service.handleBridgeSearch(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/trace") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeTraceRequest>(req);
        json(res, 200, service.handleBridgeTrace(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/add") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeAddRequest>(req);
        json(res, 200, service.add(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/forget") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeForgetRequest>(req);
        json(res, 200, service.handleBridgeForget(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/purge-scope") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgePurgeScopeRequest>(req);
        json(res, 200, service.handleBridgePurgeScope(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/export") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeExportRequest>(req);
        json(res, 200, service.handleBridgeExport(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/export-file") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeExportFileRequest>(req);
        json(res, 200, service.handleBridgeExportFile(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/backup") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeBackupRequest>(req);
        json(res, 200, await service.handleBridgeBackup(body));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/memory/repair") {
        if (!auth(req, res)) return;
        const body = await readJsonBody<MemoryBridgeRepairRequest>(req);
        json(res, 200, await service.handleBridgeRepair(body));
        return;
      }

      if (req.method === "GET" && req.url === "/v1/memory/integrity") {
        if (!auth(req, res)) return;
        json(res, 200, service.handleBridgeIntegrity());
        return;
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve memory bridge server address");
  }

  return {
    token,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
