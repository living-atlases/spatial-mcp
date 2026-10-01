import type { InteractiveOidcConfig } from "./oidc-auth.ts";

/**
 * Configuration from command-line flags and environment variables (flags win).
 *
 *   --spatial <url> | SPATIAL_URL        spatial-service base URL including /ws (default https://spatial.l-a.site/ws)
 *   --geoserver <url> | SPATIAL_GEOSERVER_URL   GeoServer base (default: <host>/geoserver)
 *   SPATIAL_READONLY=1                    refuse every write
 *
 *   OIDC login of the person (default; no secret anywhere): a public client, Authorization Code + PKCE in the browser
 *   SPATIAL_OIDC_ISSUER                   e.g. https://auth.example.org/cas/oidc (endpoints come from its discovery document)
 *   SPATIAL_OIDC_CLIENT_ID                public client registered for spatial-mcp
 *   SPATIAL_OIDC_SCOPE                    default "openid profile email roles ala offline_access"
 *   SPATIAL_OIDC_FLOW                     "browser" (default) or "device" (RFC 8628, for machines without a browser)
 *   SPATIAL_OIDC_REDIRECT_PORT            fixed loopback port (default: any free one)
 *   SPATIAL_OIDC_REDIRECT_HOST            "127.0.0.1" (default) or "localhost"
 *   SPATIAL_OIDC_LOGIN_WAIT_MS            how long a tool call waits for the browser login (default 45000)
 *   SPATIAL_TOKEN_STORE                   where the refresh token is kept: "auto" (OS keyring, else a 0600 file), "keyring", "file"
 *
 *   Web session for the admin pages of spatial-service versions that refuse bearer tokens there (3.1.0):
 *   SPATIAL_USERNAME                      portal admin account; its password is read from the OS keyring / 0600 file
 *                                         (store it with `spatial-mcp set-password`), never from the MCP config
 *   SPATIAL_PASSWORD                      deprecated: the password in plain text (falls back to SPATIAL_OIDC_PASSWORD)
 *
 *   Machine credentials (CI):
 *   SPATIAL_TOKEN                         a Bearer JWT (OIDC access token of a user with the admin role)
 *   SPATIAL_OIDC_TOKEN_URL                token endpoint (overrides discovery)
 *   SPATIAL_OIDC_CLIENT_SECRET            confidential client: client credentials or password grant instead of the browser login
 *   SPATIAL_OIDC_USERNAME / _PASSWORD     user for the password grant (admin tasks need a user with ROLE_ADMIN)
 *   SPATIAL_API_KEY                       spatial-service serviceKey / API key (only /tasks/create and /tasks/cancel)
 *   SPATIAL_ALLOWED_DIRS                  ":"-separated directories layer zips may be read from
 *   SPATIAL_POLL_WAIT_MS                  how long a write waits for its tasks before handing back (default 20000)
 *   SPATIAL_TIMEOUT_MS                    per-request HTTP timeout, raise it for large layer uploads (default 300000)
 *   PORT / HOST                           HTTP transport only (default 127.0.0.1:3920)
 */
export interface OidcConfig {
  issuer?: string;
  tokenUrl?: string;
  clientId: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  scope: string;
}

export interface Config {
  /** Where the refresh token and the fallback admin password are kept (SPATIAL_TOKEN_STORE). */
  tokenStore?: "auto" | "keyring" | "file";
  /** The user's own OIDC login (browser/device), when a public client is configured. */
  interactive?: InteractiveOidcConfig;
  url: string;
  geoserverUrl: string;
  readonly: boolean;
  token?: string;
  oidc?: OidcConfig;
  apiKey?: string;
  /** Admin account for the browser-like session the admin pages need; without password, it is read from the store. */
  login?: { username: string; password?: string };
  pollWaitMs: number;
  timeoutMs?: number;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = (flag("spatial") ?? env["SPATIAL_URL"] ?? "https://spatial.l-a.site/ws").replace(/\/+$/, "");
  const geoserverUrl = (flag("geoserver") ?? env["SPATIAL_GEOSERVER_URL"] ?? new URL("/geoserver", url).toString()).replace(/\/+$/, "");
  const clientId = env["SPATIAL_OIDC_CLIENT_ID"];
  // A secret or a password means the old machine grants (CI); a bare public client means the user's own login.
  const machine = !!(env["SPATIAL_OIDC_CLIENT_SECRET"] || env["SPATIAL_OIDC_USERNAME"] || env["SPATIAL_OIDC_PASSWORD"] || env["SPATIAL_OIDC_TOKEN_URL"]);
  const interactive = clientId && !machine ? interactiveFrom(env, clientId) : undefined;
  const oidc: OidcConfig | undefined = clientId && machine
    ? {
        issuer: env["SPATIAL_OIDC_ISSUER"],
        tokenUrl: env["SPATIAL_OIDC_TOKEN_URL"],
        clientId,
        clientSecret: env["SPATIAL_OIDC_CLIENT_SECRET"],
        username: env["SPATIAL_OIDC_USERNAME"],
        password: env["SPATIAL_OIDC_PASSWORD"],
        scope: env["SPATIAL_OIDC_SCOPE"] ?? "openid profile email roles ala",
      }
    : undefined;
  if (oidc && !oidc.issuer && !oidc.tokenUrl) throw new Error("SPATIAL_OIDC_CLIENT_ID is set but neither SPATIAL_OIDC_ISSUER nor SPATIAL_OIDC_TOKEN_URL is");
  return {
    url,
    geoserverUrl,
    readonly: /^(1|true|yes)$/i.test(env["SPATIAL_READONLY"] ?? "") || argv.includes("--readonly"),
    token: env["SPATIAL_TOKEN"] || undefined,
    tokenStore: oneOf(env, "SPATIAL_TOKEN_STORE", ["auto", "keyring", "file"] as const, "auto"),
    interactive,
    oidc,
    apiKey: env["SPATIAL_API_KEY"] || undefined,
    login: loginFrom(env),
    pollWaitMs: Number(env["SPATIAL_POLL_WAIT_MS"] ?? 20000),
    timeoutMs: env["SPATIAL_TIMEOUT_MS"] ? Number(env["SPATIAL_TIMEOUT_MS"]) : undefined,
  };
}

function loginFrom(env: NodeJS.ProcessEnv) {
  const username = env["SPATIAL_USERNAME"] || env["SPATIAL_OIDC_USERNAME"];
  const password = env["SPATIAL_PASSWORD"] || env["SPATIAL_OIDC_PASSWORD"] || undefined;
  return username ? { username, password } : undefined;
}

function interactiveFrom(env: NodeJS.ProcessEnv, clientId: string): InteractiveOidcConfig {
  const issuer = env["SPATIAL_OIDC_ISSUER"];
  if (!issuer) throw new Error("SPATIAL_OIDC_CLIENT_ID is set but SPATIAL_OIDC_ISSUER is not");
  return {
    issuer,
    clientId,
    scope: env["SPATIAL_OIDC_SCOPE"] ?? "openid profile email roles ala offline_access",
    flow: oneOf(env, "SPATIAL_OIDC_FLOW", ["browser", "device"], "browser"),
    redirectPort: Number(env["SPATIAL_OIDC_REDIRECT_PORT"] ?? 0),
    redirectHost: oneOf(env, "SPATIAL_OIDC_REDIRECT_HOST", ["127.0.0.1", "localhost"], "127.0.0.1"),
    tokenStore: oneOf(env, "SPATIAL_TOKEN_STORE", ["auto", "keyring", "file"] as const, "auto"),
    loginWaitMs: Number(env["SPATIAL_OIDC_LOGIN_WAIT_MS"] ?? 45_000),
  };
}

/** Values that must never reach the model. */
export const secretsOf = (c: Config) => [c.token, c.apiKey, c.oidc?.clientSecret, c.oidc?.password, c.login?.password];

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], def: T): T {
  const v = (env[name] || def) as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v;
}
