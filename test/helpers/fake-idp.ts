import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A small standards-only OIDC provider, enough to exercise what spatial-mcp relies on:
 * - discovery at <issuer>/.well-known/openid-configuration;
 * - /authorize for a public client: only loopback redirect URIs, PKCE S256 required, the user is already "logged in"
 *   (a test plays the browser by following the 302 back to the loopback callback);
 * - /token: authorization_code (checks the verifier), refresh_token (rotates; old ones become invalid_grant),
 *   device_code (authorization_pending until approve());
 * - /device: RFC 8628 device authorization.
 * Tokens are unsigned JWT-shaped strings with the claims spatial-service reads (sub, email, role).
 */
export async function startFakeIdp(opts: { clientId?: string; user?: Record<string, unknown>; accessTtl?: number; device?: boolean } = {}) {
  const clientId = opts.clientId ?? "spatial-mcp";
  const user = opts.user ?? { sub: "42", email: "admin@example.org", role: ["ROLE_ADMIN", "ROLE_USER"] };
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce?: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const devices = new Map<string, { userCode: string; approved: boolean }>();
  const requests: string[] = [];
  const grants: string[] = [];
  const rnd = () => randomBytes(12).toString("base64url");
  const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  const issue = (nonce?: string) => {
    const now = Math.floor(Date.now() / 1000);
    const access = jwt({ ...user, iss: issuer, client_id: clientId, jti: rnd(), iat: now, exp: now + (opts.accessTtl ?? 3600) });
    const refresh = `rt-${rnd()}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, id_token: jwt({ ...user, iss: issuer, aud: clientId, nonce, iat: now, exp: now + 3600 }), token_type: "Bearer", expires_in: opts.accessTtl ?? 3600 };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    requests.push(`${req.method} ${url.pathname}`);
    const json = (code: number, body: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const err = (error: string, description = error) => json(400, { error, error_description: description });

    if (url.pathname === "/oidc/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(opts.device === false ? {} : { device_authorization_endpoint: `${issuer}/device` }),
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oidc/authorize") {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      if (q.get("client_id") !== clientId || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(redirectUri)) return err("invalid_request", "unregistered client or redirect_uri");
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return err("invalid_request", "PKCE S256 required");
      const code = rnd();
      codes.set(code, { challenge: q.get("code_challenge")!, redirectUri, nonce: q.get("nonce") ?? undefined });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      return res.writeHead(302, { Location: back.toString() }).end();
    }
    if (url.pathname === "/oidc/device" && req.method === "POST") {
      const f = new URLSearchParams(await body(req));
      if (f.get("client_id") !== clientId) return err("invalid_client");
      const deviceCode = rnd();
      const userCode = "ABCD-EFGH";
      devices.set(deviceCode, { userCode, approved: false });
      return json(200, { device_code: deviceCode, user_code: userCode, verification_uri: `${issuer}/activate`, interval: 0.01, expires_in: 60 });
    }
    if (url.pathname === "/oidc/token" && req.method === "POST") {
      const f = new URLSearchParams(await body(req));
      grants.push(f.get("grant_type") ?? "");
      if (f.get("client_id") !== clientId) return err("invalid_client");
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        if (!c) return err("invalid_grant", "unknown or used code");
        if (c.redirectUri !== f.get("redirect_uri")) return err("invalid_grant", "redirect_uri mismatch");
        if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return err("invalid_grant", "PKCE verification failed");
        return json(200, issue(c.nonce));
      }
      if (f.get("grant_type") === "refresh_token") {
        const rt = f.get("refresh_token") ?? "";
        if (!refreshTokens.delete(rt)) return err("invalid_grant", "refresh token expired or revoked");
        return json(200, issue());
      }
      if (f.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        const d = devices.get(f.get("device_code") ?? "");
        if (!d) return err("invalid_grant");
        if (!d.approved) return err("authorization_pending");
        devices.delete(f.get("device_code")!);
        return json(200, issue());
      }
      return err("unsupported_grant_type");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/oidc`;

  return {
    issuer,
    clientId,
    requests,
    grants,
    /** Whether spatial-service would accept this bearer token (issued here and not expired). */
    validAccessToken: (t: string) => accessTokens.has(t),
    revokeAllRefreshTokens: () => refreshTokens.clear(),
    approveDevice: () => devices.forEach((d) => (d.approved = true)),
    /** Play the logged-in user's browser: open the authorization URL and follow the redirect to the loopback callback. */
    async browse(authorizeUrl: string): Promise<{ status: number; text: string }> {
      const r = await fetch(authorizeUrl, { redirect: "manual" });
      const loc = r.headers.get("location");
      if (!loc) return { status: r.status, text: await r.text() };
      const cb = await fetch(loc);
      return { status: cb.status, text: await cb.text() };
    },
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
