#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { staticToken } from "./auth.ts";
import { loadConfig, type Config } from "./config.ts";
import { createServer } from "./server.ts";
import { SpatialClient } from "./spatial-client.ts";

/**
 * Streamable HTTP transport, stateless: every POST /mcp gets a fresh MCP server bound to the caller's own
 * bearer token, which is forwarded to spatial-service and never stored. Meant to run next to spatial-service
 * (e.g. as a la-docker-compose service behind the same nginx), so users connect by URL and install nothing.
 * No shared credentials live here: without a token only public tools work.
 */
export function startHttp(config: Config = loadConfig(), port = Number(process.env["PORT"] ?? 3920), host = process.env["HOST"] ?? "127.0.0.1"): Promise<Server> {
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, spatial: config.url, poc: true }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no SSE stream to resume, no session to delete.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const token = bearer(req);
    const client = new SpatialClient(config.url, { auth: token ? staticToken(token) : undefined });
    const server = createServer({ client, config, secrets: [token] });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, await readJson(req));
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer)));
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  const m = typeof h === "string" ? h.match(/^Bearer\s+(.+)$/i) : null;
  return m?.[1];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5_000_000) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/spatial-mcp-http")) {
  const config = loadConfig();
  startHttp(config).then((s) => {
    const a = s.address();
    console.error(`spatial-mcp (POC) on http://${typeof a === "object" && a ? `${a.address}:${a.port}` : a}/mcp -> ${config.url}`);
  });
}
