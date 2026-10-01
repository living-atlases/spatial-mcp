import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Standards-only OIDC for an interactive user: discovery (OpenID Connect Discovery 1.0), Authorization Code + PKCE
 * with a loopback redirect (RFC 7636, RFC 8252), the Device Authorization Grant (RFC 8628) and refresh tokens.
 * Public client, no secret. Works with any compliant IdP (CAS 6/7 OIDC, Keycloak, Cognito…).
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  userinfo_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export class OidcError extends Error {}

export async function discover(issuer: string, fetchImpl: FetchLike = fetch): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new OidcError(`OIDC discovery failed (${res.status}) for ${url}`);
  const d = (await res.json()) as Partial<Discovery>;
  if (!d.authorization_endpoint || !d.token_endpoint) throw new OidcError(`OIDC discovery for ${issuer} has no authorization_endpoint/token_endpoint`);
  return d as Discovery;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** RFC 7636 S256 pair. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** Claims of a JWT, without checking its signature: only for showing who is logged in, never to authorize. */
export function jwtClaims(jwt: string | undefined): Record<string, unknown> | undefined {
  const part = jwt?.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function tokenRequest(d: Discovery, form: Record<string, string>, fetchImpl: FetchLike): Promise<TokenSet> {
  const res = await fetchImpl(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenSet> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw Object.assign(new OidcError(`OIDC token request (${form["grant_type"]}) failed (${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`), { code: body.error });
  }
  return body as TokenSet;
}

export function refresh(d: Discovery, clientId: string, refreshToken: string, scope: string, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  return tokenRequest(d, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope }, fetchImpl);
}

export interface PendingLogin {
  /** URL the user opens in a browser (loopback) or the verification URL (device). */
  url: string;
  /** Device flow: code the user types, when the IdP has no verification_uri_complete. */
  userCode?: string;
  /** Settles with the tokens once the user has logged in (or fails / times out). */
  done: Promise<TokenSet>;
  cancel(): void;
}

export interface LoginParams {
  clientId: string;
  scope: string;
  fetch?: FetchLike;
  /** Loopback port (0 = any free port). IdPs that compare redirect URIs exactly (Cognito) need a fixed, registered one. */
  port?: number;
  /** Host in the redirect URI: "127.0.0.1" (RFC 8252's choice, default) or "localhost" (Cognito only allows that one over http). */
  redirectHost?: "127.0.0.1" | "localhost";
  /** Give up after this long (default 10 minutes). */
  timeoutMs?: number;
}

/**
 * Authorization Code + PKCE with a loopback redirect: listens on 127.0.0.1, returns the authorization URL to open,
 * and resolves once the IdP redirects the browser back with a code (checked against state, exchanged with the verifier).
 */
export async function startLoopbackLogin(d: Discovery, p: LoginParams): Promise<PendingLogin> {
  const fetchImpl = p.fetch ?? fetch;
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const servers: Server[] = [];
  let timer: NodeJS.Timeout;
  let settle!: { resolve: (t: TokenSet) => void; reject: (e: Error) => void };
  const done = new Promise<TokenSet>((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => {}); // a login nobody waits for any more must not crash the process
  let redirectUri = "";
  const finish = () => {
    clearTimeout(timer);
    for (const s of servers) {
      s.close();
      s.closeAllConnections();
    }
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") return res.writeHead(404).end();
    const page = (code: number, msg: string) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!DOCTYPE html><html><head><title>spatial-mcp</title></head><body><p>${msg}</p></body></html>`);
    if (u.searchParams.get("state") !== state) return page(400, "This login link is not the current one (state mismatch). Start the login again.");
    const error = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    if (error || !code) {
      page(400, `Login failed: ${escapeHtml(u.searchParams.get("error_description") ?? error ?? "no code")}. You can close this tab.`);
      finish();
      return settle.reject(new OidcError(`login refused by the identity provider: ${u.searchParams.get("error_description") ?? error ?? "no code"}`));
    }
    try {
      const tokens = await tokenRequest(d, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: p.clientId, code_verifier: verifier }, fetchImpl);
      const claims = jwtClaims(tokens.id_token);
      if (claims && claims["nonce"] !== undefined && claims["nonce"] !== nonce) throw new OidcError("id_token nonce does not match this login");
      page(200, "Logged in to spatial-mcp. You can close this tab and go back to your assistant.");
      settle.resolve(tokens);
    } catch (e) {
      page(500, `Login failed: ${escapeHtml((e as Error).message)}`);
      settle.reject(e as Error);
    }
    finish();
  };
  const listen = (host: string, port: number) =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer(handler);
      s.once("error", reject);
      s.listen(port, host, () => resolve(s));
    });
  // Only ever on the loopback interface. "localhost" may resolve to ::1 in the browser: listen there too when possible.
  servers.push(await listen("127.0.0.1", p.port ?? 0));
  const port = (servers[0]!.address() as { port: number }).port;
  if (p.redirectHost === "localhost") servers.push(...(await listen("::1", port).then((s) => [s], () => [])));
  redirectUri = `http://${p.redirectHost ?? "127.0.0.1"}:${port}/callback`;
  timer = setTimeout(() => {
    finish();
    settle.reject(new OidcError("login timed out: nobody completed it in the browser"));
  }, p.timeoutMs ?? 600_000);
  timer.unref();
  const url = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: p.clientId, redirect_uri: redirectUri, scope: p.scope, state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(k, v);
  return {
    url: url.toString(),
    done,
    cancel: () => {
      finish();
      settle.reject(new OidcError("login cancelled"));
    },
  };
}

/** RFC 8628: for machines without a local browser (SSH). Polls the token endpoint at the interval the IdP asks for. */
export async function startDeviceLogin(d: Discovery, p: LoginParams): Promise<PendingLogin> {
  const fetchImpl = p.fetch ?? fetch;
  if (!d.device_authorization_endpoint) throw new OidcError(`${d.issuer} does not support the device authorization grant (no device_authorization_endpoint): use the browser login`);
  const res = await fetchImpl(d.device_authorization_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: p.clientId, scope: p.scope }),
  });
  const a = (await res.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; interval?: number; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !a.device_code || !a.verification_uri) throw new OidcError(`device authorization failed (${res.status}): ${a.error_description ?? a.error ?? "bad response"}`);
  let cancelled = false;
  const deadline = Date.now() + Math.min((a.expires_in ?? 600) * 1000, p.timeoutMs ?? 600_000);
  const done = (async () => {
    let interval = (a.interval ?? 5) * 1000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval).unref());
      if (cancelled) break;
      try {
        return await tokenRequest(d, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: a.device_code!, client_id: p.clientId }, fetchImpl);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          interval += 5000;
          continue;
        }
        throw e;
      }
    }
    throw new OidcError(cancelled ? "login cancelled" : "login timed out: the device code expired");
  })();
  done.catch(() => {});
  return { url: a.verification_uri_complete ?? a.verification_uri, userCode: a.verification_uri_complete ? undefined : a.user_code, done, cancel: () => (cancelled = true) };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
