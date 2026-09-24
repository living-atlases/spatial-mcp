/**
 * Configuration from command-line flags and environment variables (flags win).
 *
 *   --spatial <url> | SPATIAL_URL        spatial-service base URL including /ws (default https://spatial.l-a.site/ws)
 *   --geoserver <url> | SPATIAL_GEOSERVER_URL   GeoServer base (default: <host>/geoserver)
 *   SPATIAL_READONLY=1                    refuse every write
 *   SPATIAL_USERNAME / SPATIAL_PASSWORD   portal admin account: logs in to the admin pages like a browser
 *                                         (falls back to SPATIAL_OIDC_USERNAME / _PASSWORD)
 *   SPATIAL_TOKEN                         a Bearer JWT (OIDC access token of a user with the admin role)
 *   SPATIAL_OIDC_ISSUER                   e.g. https://auth.l-a.site/cas/oidc (discovery is used to find the token endpoint)
 *   SPATIAL_OIDC_TOKEN_URL                token endpoint (overrides discovery)
 *   SPATIAL_OIDC_CLIENT_ID / _SECRET      OIDC client
 *   SPATIAL_OIDC_USERNAME / _PASSWORD     user for the password grant (admin tasks need a user with ROLE_ADMIN)
 *   SPATIAL_OIDC_SCOPE                    default "openid profile email roles ala"
 *   SPATIAL_API_KEY                       spatial-service serviceKey / API key (only /tasks/create and /tasks/cancel)
 *   SPATIAL_ALLOWED_DIRS                  ":"-separated directories layer zips may be read from
 *   SPATIAL_POLL_WAIT_MS                  how long a write waits for its tasks before handing back (default 20000)
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
  url: string;
  geoserverUrl: string;
  readonly: boolean;
  token?: string;
  oidc?: OidcConfig;
  apiKey?: string;
  /** Admin account for the browser-like session the admin pages need. */
  login?: { username: string; password: string };
  pollWaitMs: number;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = (flag("spatial") ?? env["SPATIAL_URL"] ?? "https://spatial.l-a.site/ws").replace(/\/+$/, "");
  const geoserverUrl = (flag("geoserver") ?? env["SPATIAL_GEOSERVER_URL"] ?? new URL("/geoserver", url).toString()).replace(/\/+$/, "");
  const clientId = env["SPATIAL_OIDC_CLIENT_ID"];
  const oidc: OidcConfig | undefined = clientId
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
    oidc,
    apiKey: env["SPATIAL_API_KEY"] || undefined,
    login: loginFrom(env),
    pollWaitMs: Number(env["SPATIAL_POLL_WAIT_MS"] ?? 20000),
  };
}

function loginFrom(env: NodeJS.ProcessEnv) {
  const username = env["SPATIAL_USERNAME"] || env["SPATIAL_OIDC_USERNAME"];
  const password = env["SPATIAL_PASSWORD"] || env["SPATIAL_OIDC_PASSWORD"];
  return username && password ? { username, password } : undefined;
}

/** Values that must never reach the model. */
export const secretsOf = (c: Config) => [c.token, c.apiKey, c.oidc?.clientSecret, c.oidc?.password, c.login?.password];
