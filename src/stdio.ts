#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Agent, setGlobalDispatcher } from "undici";
import { noAuth, OidcAuth, staticToken, type Auth } from "./auth.ts";
import { loadConfig, secretsOf, type Config } from "./config.ts";
import { InteractiveOidcAuth, loginMessage } from "./oidc-auth.ts";
import { createServer } from "./server.ts";
import { SpatialClient } from "./spatial-client.ts";
import { openTokenStore, passwordKey } from "./token-store.ts";
import { WebSession } from "./web-session.ts";

export function authFor(config: Config): Auth {
  if (config.token) return staticToken(config.token);
  if (config.interactive) return new InteractiveOidcAuth(config.interactive);
  if (config.oidc) return new OidcAuth(config.oidc);
  return noAuth;
}

/** Web session for the admin pages: the password comes from the deprecated env var, else from the keyring/file. */
export function sessionFor(config: Config): WebSession | undefined {
  const login = config.login;
  if (!login) return undefined;
  const store = () => openTokenStore(passwordKey(config.url, login.username), config.tokenStore);
  return new WebSession(login.username, login.password ?? (async () => (await store()).load()));
}

/** Client for a config: bearer auth for the API (and the admin pages when the portal accepts it), a web session otherwise. */
export function clientFor(config: Config, auth: Auth = authFor(config)): SpatialClient {
  // fetch has its own 300 s headers/body timeouts: a slow layer upload hits them before our AbortSignal.
  if (config.timeoutMs) setGlobalDispatcher(new Agent({ headersTimeout: config.timeoutMs, bodyTimeout: config.timeoutMs }));
  return new SpatialClient(config.url, { auth, apiKey: config.apiKey, timeoutMs: config.timeoutMs, session: sessionFor(config) });
}

export async function main() {
  // stdout carries JSON-RPC: anything else must go to stderr.
  console.log = console.error;
  const config = loadConfig();
  const auth = authFor(config);
  const client = clientFor(config, auth);
  const server = createServer({ client, config, auth, secrets: secretsOf(config) });
  await server.connect(new StdioServerTransport());
  if (config.login?.password) console.error("spatial-mcp: SPATIAL_PASSWORD is deprecated (it sits in plain text in the MCP config): use the OIDC login, or store it with `spatial-mcp set-password`");
  console.error(`spatial-mcp (POC) on stdio -> ${config.url} (auth: ${auth.describe}${config.login ? `, admin pages as ${config.login.username}` : ""}${config.readonly ? ", read-only" : ""})`);
}

/**
 * Terminal commands, run by the person (never by the assistant):
 *   spatial-mcp login | logout | status    OIDC login in the browser (or device flow) ahead of time
 *   spatial-mcp set-password | forget-password   admin password for the web-session fallback, typed with echo off
 * They take the same flags and environment as the server (--spatial, SPATIAL_OIDC_*, SPATIAL_USERNAME).
 */
export async function cli(cmd: string, config: Config = loadConfig(process.argv.slice(3))): Promise<number> {
  if (cmd === "set-password" || cmd === "forget-password") {
    const username = config.login?.username;
    if (!username) throw new Error("set SPATIAL_USERNAME (the admin account) first");
    const store = await openTokenStore(passwordKey(config.url, username), config.tokenStore);
    if (cmd === "forget-password") {
      await store.clear();
      console.error(`forgot the password of ${username} for ${new URL(config.url).origin}`);
      return 0;
    }
    const password = await readHidden(`password of ${username} for ${new URL(config.url).origin}: `);
    if (!password) throw new Error("empty password: nothing stored");
    await store.save(password);
    console.error(`stored in ${store.describe}`);
    return 0;
  }
  if (!config.interactive) throw new Error("no OIDC login configured: set SPATIAL_OIDC_ISSUER and SPATIAL_OIDC_CLIENT_ID (see README)");
  const auth = new InteractiveOidcAuth({ ...config.interactive, loginWaitMs: 600_000 });
  if (cmd === "logout") {
    await auth.logout();
    console.error("logged out (refresh token removed)");
    return 0;
  }
  if (cmd === "login") {
    const p = await auth.startLogin();
    console.error(loginMessage(p).replace("Not logged in to the portal yet. ", "").replace(/ Then try again\.$/, ""));
    await p.done;
  }
  const s = await auth.status();
  console.error(s.loggedIn ? `logged in as ${s.user ?? "?"}${s.roles ? ` (roles: ${s.roles.join(", ")})` : ""}; refresh token in ${s.tokenStore}` : "not logged in");
  return s.loggedIn ? 0 : 1;
}

/** A line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("set-password needs an interactive terminal");
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const COMMANDS = ["login", "logout", "status", "set-password", "forget-password"];

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/spatial-mcp")) {
  const cmd = process.argv[2];
  (cmd && COMMANDS.includes(cmd) ? cli(cmd).then((code) => process.exit(code)) : main()).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
