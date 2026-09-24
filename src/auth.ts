import { AsyncLocalStorage } from "node:async_hooks";
import type { OidcConfig } from "./config.ts";

/**
 * Where the Authorization header for spatial-service comes from.
 *
 * spatial-service 3.x protects /manageLayers/* with @RequireAdmin, which needs an authenticated *user*
 * with the admin role (an API key is no longer enough), so the header must carry a user's OIDC token:
 * - HTTP transport: the token the MCP client sent to us (per request, never stored);
 * - stdio: SPATIAL_TOKEN, or a token obtained with the OIDC password grant and cached until it expires.
 */
export interface Auth {
  /** Headers for an authenticated call, or {} when no credentials are configured. */
  headers(): Promise<Record<string, string>>;
  readonly describe: string;
}

export const noAuth: Auth = { headers: async () => ({}), describe: "none (public endpoints only)" };

export const staticToken = (token: string): Auth => ({ headers: async () => ({ Authorization: `Bearer ${token}` }), describe: "SPATIAL_TOKEN" });

/** Token of the MCP request being served (HTTP transport). */
export const requestToken = new AsyncLocalStorage<string>();
export const forwardedToken = (fallback: Auth = noAuth): Auth => ({
  headers: async () => {
    const t = requestToken.getStore();
    return t ? { Authorization: `Bearer ${t}` } : fallback.headers();
  },
  describe: "the caller's own bearer token",
});

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class OidcAuth implements Auth {
  private cached?: { token: string; expires: number };
  private tokenUrl?: string;
  readonly describe: string;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.describe = cfg.username ? `OIDC password grant as ${cfg.username}` : "OIDC client credentials (no user: admin endpoints will refuse it)";
  }

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}` };
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now() + 30_000) return this.cached.token;
    const url = await this.endpoint();
    const form = new URLSearchParams({ scope: this.cfg.scope });
    if (this.cfg.username && this.cfg.password) {
      form.set("grant_type", "password");
      form.set("username", this.cfg.username);
      form.set("password", this.cfg.password);
    } else {
      form.set("grant_type", "client_credentials");
    }
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (this.cfg.clientSecret) headers["Authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString("base64")}`;
    else form.set("client_id", this.cfg.clientId);
    const res = await this.fetchImpl(url, { method: "POST", headers, body: form });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`OIDC token request failed (${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`);
    this.cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private async endpoint(): Promise<string> {
    if (this.cfg.tokenUrl) return this.cfg.tokenUrl;
    if (this.tokenUrl) return this.tokenUrl;
    const res = await this.fetchImpl(`${this.cfg.issuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${this.cfg.issuer}`);
    const d = (await res.json()) as { token_endpoint?: string };
    if (!d.token_endpoint) throw new Error(`OIDC discovery for ${this.cfg.issuer} has no token_endpoint`);
    return (this.tokenUrl = d.token_endpoint);
  }
}
