import { spawn } from "node:child_process";
import { nonInteractive, type Auth } from "./auth.ts";
import { discover, jwtClaims, OidcError, refresh, startDeviceLogin, startLoopbackLogin, type Discovery, type FetchLike, type PendingLogin, type TokenSet } from "./oidc.ts";
import { openTokenStore, storeKey, type TokenStore } from "./token-store.ts";

export interface InteractiveOidcConfig {
  issuer: string;
  clientId: string;
  scope: string;
  /** "browser" (Authorization Code + PKCE, loopback redirect) or "device" (RFC 8628). */
  flow: "browser" | "device";
  /** Fixed loopback port (IdPs that match redirect URIs exactly, e.g. Cognito); 0 = any. */
  redirectPort: number;
  redirectHost: "127.0.0.1" | "localhost";
  tokenStore: "auto" | "keyring" | "file";
  /**
   * How long a tool call that needs a login waits for it before handing back the login URL. Keep it under the MCP
   * client's request timeout (60 s in the TypeScript SDK); the login stays open and a retry picks it up.
   */
  loginWaitMs: number;
}

export interface LoginStatus {
  loggedIn: boolean;
  user?: string;
  roles?: string[];
  expiresAt?: string;
  tokenStore?: string;
  pendingLogin?: { url: string; userCode?: string };
}

/** Thrown when an admin call needs a login the user has not completed yet: the message carries the URL to open. */
export class LoginRequired extends Error {}

/**
 * Experimental (WIP): OIDC login of the person using the assistant, no password anywhere. spatial-service 3.1.0
 * refuses the token on its @RequireAdmin pages, so the web session (SPATIAL_USERNAME) stays the default. The refresh token is kept in the OS keyring
 * (or a 0600 file), the access token only in memory; it is refreshed silently and a new browser login is started
 * when the refresh token has expired or been revoked. Tokens are never logged or returned.
 */
export class InteractiveOidcAuth implements Auth {
  readonly describe: string;
  private discovery?: Promise<Discovery>;
  private store?: Promise<TokenStore>;
  private access?: { token: string; expires: number; idToken?: string };
  private refreshing?: Promise<string | undefined>;
  private pending?: PendingLogin;
  private identity?: Record<string, unknown>;

  constructor(
    readonly cfg: InteractiveOidcConfig,
    private readonly deps: { fetch?: FetchLike; openBrowser?: (url: string) => void; store?: TokenStore } = {},
  ) {
    this.describe = `experimental OIDC ${cfg.flow === "device" ? "device" : "browser"} login (${cfg.issuer}, client ${cfg.clientId})`;
  }

  private endpoints() {
    this.discovery ??= discover(this.cfg.issuer, this.deps.fetch).catch((e) => {
      this.discovery = undefined;
      throw e;
    });
    return this.discovery;
  }

  private tokenStore() {
    this.store ??= this.deps.store ? Promise.resolve(this.deps.store) : openTokenStore(storeKey(this.cfg.issuer, this.cfg.clientId), this.cfg.tokenStore);
    return this.store;
  }

  async headers(o: { interactive?: boolean } = {}): Promise<Record<string, string>> {
    if (o.interactive === false || nonInteractive.getStore()) {
      const t = await this.silentToken().catch(() => undefined);
      return t ? { Authorization: `Bearer ${t}` } : {};
    }
    return { Authorization: `Bearer ${await this.token()}` };
  }

  /** A valid access token: cached, refreshed, or (as a last resort) from a new interactive login. */
  async token(): Promise<string> {
    const t = await this.silentToken();
    if (t) return t;
    const p = await this.startLogin();
    const outcome = await Promise.race([p.done.then(() => "done" as const), new Promise<"wait">((r) => setTimeout(() => r("wait"), this.cfg.loginWaitMs).unref())]);
    if (outcome === "wait") throw new LoginRequired(loginMessage(p));
    return (await this.silentToken())!;
  }

  /** Access token without user interaction, or undefined. */
  async silentToken(): Promise<string | undefined> {
    if (this.access && this.access.expires > Date.now() + 30_000) return this.access.token;
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<string | undefined> {
    const store = await this.tokenStore();
    const rt = await store.load();
    if (!rt) return undefined;
    try {
      const tokens = await refresh(await this.endpoints(), this.cfg.clientId, rt, this.cfg.scope, this.deps.fetch);
      return this.accept(tokens, store);
    } catch (e) {
      if (!(e instanceof OidcError) || !/invalid_grant|invalid_token|expired|revoked/i.test(`${(e as { code?: string }).code} ${e.message}`)) throw e;
      await store.clear(); // expired or revoked: a new login is needed
      this.access = undefined;
      return undefined;
    }
  }

  private async accept(tokens: TokenSet, store: TokenStore): Promise<string> {
    this.access = { token: tokens.access_token, expires: Date.now() + (tokens.expires_in ?? 300) * 1000, idToken: tokens.id_token ?? this.access?.idToken };
    this.identity = jwtClaims(tokens.id_token) ?? this.identity ?? jwtClaims(tokens.access_token);
    if (tokens.refresh_token) await store.save(tokens.refresh_token);
    return tokens.access_token;
  }

  /** Start an interactive login (or return the one in progress) and open the browser on it. */
  async startLogin(force = false): Promise<PendingLogin> {
    if (this.pending && !force) return this.pending;
    this.pending?.cancel();
    const d = await this.endpoints();
    const params = { clientId: this.cfg.clientId, scope: this.cfg.scope, fetch: this.deps.fetch, port: this.cfg.redirectPort, redirectHost: this.cfg.redirectHost };
    const p = this.cfg.flow === "device" ? await startDeviceLogin(d, params) : await startLoopbackLogin(d, params);
    this.pending = p;
    const store = await this.tokenStore();
    p.done.then(
      (tokens) => this.accept(tokens, store),
      () => undefined,
    ).finally(() => {
      if (this.pending === p) this.pending = undefined;
    });
    if (this.cfg.flow === "browser") (this.deps.openBrowser ?? openBrowser)(p.url);
    return p;
  }

  /** Log in now (the spatial_login tool): waits up to loginWaitMs for the user to finish in the browser. */
  async login(force = false): Promise<LoginStatus> {
    if (!force && (await this.silentToken().catch(() => undefined))) return this.status();
    const p = await this.startLogin(force);
    const outcome = await Promise.race([p.done.then(() => "done" as const), new Promise<"wait">((r) => setTimeout(() => r("wait"), this.cfg.loginWaitMs).unref())]);
    if (outcome === "wait") return { ...(await this.status()), pendingLogin: { url: p.url, userCode: p.userCode } };
    await p.done;
    return this.status();
  }

  async logout(): Promise<void> {
    this.pending?.cancel();
    this.pending = undefined;
    this.access = undefined;
    this.identity = undefined;
    await (await this.tokenStore()).clear();
  }

  async status(): Promise<LoginStatus> {
    const loggedIn = !!(await this.silentToken().catch(() => undefined));
    const c = this.identity ?? {};
    const user = [c["email"], c["preferred_username"], c["name"], c["sub"]].find((v): v is string => typeof v === "string");
    const roles = rolesOf({ ...jwtClaims(this.access?.token), ...c });
    return {
      loggedIn,
      user: loggedIn ? user : undefined,
      roles: loggedIn && roles.length ? roles : undefined,
      expiresAt: loggedIn && this.access ? new Date(this.access.expires).toISOString() : undefined,
      tokenStore: (await this.tokenStore()).describe,
      pendingLogin: this.pending ? { url: this.pending.url, userCode: this.pending.userCode } : undefined,
    };
  }
}

/** Role claims as the usual LA IdPs name them (CAS "role"/"roles", Keycloak realm_access, Cognito groups). */
function rolesOf(c: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[ ,]+/) : []).forEach((r) => typeof r === "string" && r && out.add(r));
  add(c["role"]);
  add(c["roles"]);
  add(c["cognito:groups"]);
  add((c["realm_access"] as { roles?: unknown } | undefined)?.roles);
  return [...out];
}

export function loginMessage(p: { url: string; userCode?: string }): string {
  return p.userCode
    ? `Not logged in to the portal yet. Open ${p.url} and enter the code ${p.userCode}, then try again.`
    : `Not logged in to the portal yet. A browser window was opened for the portal login; if it did not appear, open ${p.url} . Then try again.`;
}

/** Best effort: the URL is also handed to the user, so a failure here only means they open it themselves. */
export function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser launcher (headless): the user opens the URL
  }
}
