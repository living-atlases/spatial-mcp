#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { noAuth, OidcAuth, staticToken, type Auth } from "./auth.ts";
import { loadConfig, secretsOf, type Config } from "./config.ts";
import { createServer } from "./server.ts";
import { SpatialClient } from "./spatial-client.ts";

export function authFor(config: Config): Auth {
  if (config.token) return staticToken(config.token);
  if (config.oidc) return new OidcAuth(config.oidc);
  return noAuth;
}

export async function main() {
  // stdout carries JSON-RPC: anything else must go to stderr.
  console.log = console.error;
  const config = loadConfig();
  const auth = authFor(config);
  const client = new SpatialClient(config.url, { auth, apiKey: config.apiKey });
  const server = createServer({ client, config, secrets: secretsOf(config) });
  await server.connect(new StdioServerTransport());
  console.error(`spatial-mcp (POC) on stdio -> ${config.url} (auth: ${auth.describe}${config.readonly ? ", read-only" : ""})`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/spatial-mcp")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
