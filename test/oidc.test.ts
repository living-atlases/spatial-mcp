import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, secretsOf } from "../src/config.ts";
import { discover, jwtClaims, pkce, startLoopbackLogin } from "../src/oidc.ts";
import { InteractiveOidcAuth, type InteractiveOidcConfig } from "../src/oidc-auth.ts";
import { createServer } from "../src/server.ts";
import { SpatialClient } from "../src/spatial-client.ts";
import { FileStore, KeyringStore, type TokenStore } from "../src/token-store.ts";
import { WebSession } from "../src/web-session.ts";
import { startFakeIdp } from "./helpers/fake-idp.ts";
import { startFakeSpatial } from "./helpers/fake-spatial.ts";

type Idp = Awaited<ReturnType<typeof startFakeIdp>>;
let idp: Idp;
before(async () => (idp = await startFakeIdp()));
after(() => idp.close());

/** In-memory store, so tests never touch the real keyring or the user's config dir. */
class MemoryStore implements TokenStore {
  readonly describe = "memory";
  value?: string;
  saves = 0;
  async load() {
    return this.value;
  }
  async save(v: string) {
    this.value = v;
    this.saves++;
  }
  async clear() {
    this.value = undefined;
  }
}

function makeAuth(o: { flow?: "browser" | "device"; loginWaitMs?: number; store?: MemoryStore; autoBrowse?: boolean } = {}) {
  const store = o.store ?? new MemoryStore();
  const opened: string[] = [];
  const cfg: InteractiveOidcConfig = { issuer: idp.issuer, clientId: idp.clientId, scope: "openid profile email roles", flow: o.flow ?? "browser", redirectPort: 0, redirectHost: "127.0.0.1", tokenStore: "file", loginWaitMs: o.loginWaitMs ?? 5000 };
  const auth = new InteractiveOidcAuth(cfg, {
    store,
    openBrowser: (url) => {
      opened.push(url);
      if (o.autoBrowse !== false) void idp.browse(url); // the user logs in straight away
    },
  });
  return { auth, store, opened };
}

describe("OIDC protocol pieces", () => {
  test("PKCE S256: the challenge is the base64url SHA-256 of the verifier", () => {
    const { verifier, challenge } = pkce();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
    assert.notEqual(pkce().verifier, verifier);
  });

  test("discovery finds the endpoints, and fails clearly on a bad issuer", async () => {
    const d = await discover(`${idp.issuer}/`);
    assert.equal(d.token_endpoint, `${idp.issuer}/token`);
    assert.equal(d.device_authorization_endpoint, `${idp.issuer}/device`);
    await assert.rejects(discover(`${idp.issuer}/nope`), /discovery failed \(404\)/);
  });

  test("loopback login: authorization URL, code exchange with the verifier, nonce checked", async () => {
    const d = await discover(idp.issuer);
    const p = await startLoopbackLogin(d, { clientId: idp.clientId, scope: "openid" });
    const u = new URL(p.url);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.match(u.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(u.searchParams.get("client_secret"), null);
    const page = await idp.browse(p.url);
    assert.equal(page.status, 200);
    assert.match(page.text, /Logged in/);
    const tokens = await p.done;
    assert.equal(jwtClaims(tokens.id_token)!["nonce"], u.searchParams.get("nonce"));
    assert.ok(idp.validAccessToken(tokens.access_token));
  });

  test("a callback with the wrong state is refused and the login stays open", async () => {
    const d = await discover(idp.issuer);
    const p = await startLoopbackLogin(d, { clientId: idp.clientId, scope: "openid" });
    const cb = new URL(new URL(p.url).searchParams.get("redirect_uri")!);
    cb.searchParams.set("code", "forged");
    cb.searchParams.set("state", "not-the-state");
    const r = await fetch(cb);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /state mismatch/);
    await idp.browse(p.url);
    assert.ok((await p.done).access_token);
  });

  test("an error from the IdP (access denied) fails the login", async () => {
    const d = await discover(idp.issuer);
    const p = await startLoopbackLogin(d, { clientId: idp.clientId, scope: "openid" });
    const cb = new URL(new URL(p.url).searchParams.get("redirect_uri")!);
    cb.searchParams.set("state", new URL(p.url).searchParams.get("state")!);
    cb.searchParams.set("error", "access_denied");
    await fetch(cb);
    await assert.rejects(p.done, /refused by the identity provider: access_denied/);
  });
});

describe("InteractiveOidcAuth", () => {
  test("first admin call logs in through the browser, then reuses the token; only the refresh token is stored", async () => {
    const { auth, store, opened } = makeAuth();
    const h = await auth.headers();
    assert.match(h["Authorization"]!, /^Bearer /);
    assert.equal(opened.length, 1);
    assert.match(store.value!, /^rt-/);
    assert.ok(!store.value!.includes(".")); // not the access token
    assert.deepEqual(await auth.headers(), h);
    assert.equal(opened.length, 1);
    const s = await auth.status();
    assert.equal(s.loggedIn, true);
    assert.equal(s.user, "admin@example.org");
    assert.deepEqual(s.roles, ["ROLE_ADMIN", "ROLE_USER"]);
  });

  test("silent refresh after a restart, with the rotated refresh token persisted", async () => {
    const store = new MemoryStore();
    await makeAuth({ store }).auth.headers();
    const first = store.value;
    const { auth, opened } = makeAuth({ store }); // a new process: nothing in memory
    assert.match((await auth.headers({ interactive: false }))["Authorization"]!, /^Bearer /);
    assert.equal(opened.length, 0, "no browser for a refresh");
    assert.notEqual(store.value, first, "rotated refresh token saved");
    assert.ok(idp.grants.includes("refresh_token"));
  });

  test("an expired or revoked refresh token clears the store and starts a new login", async () => {
    const store = new MemoryStore();
    await makeAuth({ store }).auth.headers();
    idp.revokeAllRefreshTokens();
    const { auth, opened } = makeAuth({ store });
    assert.deepEqual(await auth.headers({ interactive: false }), {}, "non-interactive: nothing, no login");
    assert.equal(store.value, undefined);
    assert.equal(opened.length, 0);
    assert.match((await auth.headers())["Authorization"]!, /^Bearer /);
    assert.equal(opened.length, 1);
    assert.match(store.value!, /^rt-/);
  });

  test("a login nobody finishes hands back the URL; the retry after the user logs in succeeds", async () => {
    const { auth, opened } = makeAuth({ autoBrowse: false, loginWaitMs: 50 });
    await assert.rejects(auth.headers(), (e: Error) => e.message.includes(opened[0]!) && /Not logged in/.test(e.message));
    const again = auth.headers(); // same pending login, not a second browser window
    await idp.browse(opened[0]!);
    assert.match((await again)["Authorization"]!, /^Bearer /);
    assert.equal(opened.length, 1);
  });

  test("device flow: pending until the user approves, no browser spawned", async () => {
    const { auth, opened } = makeAuth({ flow: "device", loginWaitMs: 2000 });
    const status = auth.login();
    setTimeout(() => idp.approveDevice(), 50);
    const s = await status;
    assert.equal(s.loggedIn, true);
    assert.equal(opened.length, 0);
  });

  test("device flow without the user: the verification URL and code come back", async () => {
    const { auth } = makeAuth({ flow: "device", loginWaitMs: 30 });
    const s = await auth.login();
    assert.equal(s.loggedIn, false);
    assert.equal(s.pendingLogin?.userCode, "ABCD-EFGH");
    assert.match(s.pendingLogin!.url, /\/activate$/);
    await auth.logout();
  });

  test("logout forgets the refresh token", async () => {
    const { auth, store } = makeAuth();
    await auth.headers();
    await auth.logout();
    assert.equal(store.value, undefined);
    assert.equal((await auth.status()).loggedIn, false);
  });
});

describe("token store", () => {
  test("file fallback is 0600 in a 0700 directory, and clear removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spatial-mcp-store-"));
    const f = new FileStore("https://idp.example.org/oidc#spatial-mcp", dir);
    assert.equal(await f.load(), undefined);
    await f.save("rt-1");
    assert.equal(await f.load(), "rt-1");
    if (process.platform !== "win32") {
      assert.equal(statSync(f.path).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "tokens")).mode & 0o777, 0o700);
    }
    assert.ok(!f.path.includes("idp.example.org"), "file name does not reveal the issuer");
    await f.clear();
    assert.equal(await f.load(), undefined);
  });

  test("no usable keyring (module missing, or no Secret Service) means the file fallback", async () => {
    assert.equal(await KeyringStore.open("k", async () => { throw new Error("Cannot find module"); }), undefined);
    class Broken {
      getPassword(): string { throw new Error("no secret service"); }
      setPassword() {}
      deletePassword() {}
    }
    assert.equal(await KeyringStore.open("k", async () => Broken), undefined);
    const mem = new Map<string, string>();
    class Ok {
      constructor(readonly s: string, readonly a: string) {}
      getPassword() { return mem.get(this.a) ?? null; }
      setPassword(v: string) { mem.set(this.a, v); }
      deletePassword() { return mem.delete(this.a); }
    }
    const k = (await KeyringStore.open("acct", async () => Ok))!;
    await k.save("rt-9");
    assert.equal(await k.load(), "rt-9");
    await k.clear();
    assert.equal(await k.load(), undefined);
  });
});

describe("config", () => {
  test("issuer + public client = the user's own login, with no secret anywhere", () => {
    const c = loadConfig([], { SPATIAL_OIDC_ISSUER: "https://auth.example.org/cas/oidc", SPATIAL_OIDC_CLIENT_ID: "spatial-mcp" });
    assert.equal(c.interactive?.flow, "browser");
    assert.equal(c.interactive?.redirectHost, "127.0.0.1");
    assert.equal(c.interactive?.loginWaitMs, 45_000);
    assert.equal(c.oidc, undefined);
    assert.equal(c.login, undefined);
    assert.deepEqual(secretsOf(c).filter(Boolean), []);
    assert.throws(() => loadConfig([], { SPATIAL_OIDC_CLIENT_ID: "x" }), /ISSUER/);
    assert.throws(() => loadConfig([], { SPATIAL_OIDC_ISSUER: "https://a.example.org", SPATIAL_OIDC_CLIENT_ID: "x", SPATIAL_OIDC_FLOW: "implicit" }), /SPATIAL_OIDC_FLOW must be/);
  });

  test("a client secret or a password keeps the machine grants (CI)", () => {
    const c = loadConfig([], { SPATIAL_OIDC_ISSUER: "https://a.example.org", SPATIAL_OIDC_CLIENT_ID: "x", SPATIAL_OIDC_CLIENT_SECRET: "s", SPATIAL_USERNAME: "u@example.org" });
    assert.equal(c.interactive, undefined);
    assert.equal(c.oidc?.clientSecret, "s");
    assert.deepEqual(c.login, { username: "u@example.org", password: undefined });
  });
});

test("web session reads the password from the store only when it has to log in", async () => {
  const strict = await startFakeSpatial({ bearerOnAdminPages: false });
  let reads = 0;
  const session = new WebSession(strict.login.username, async () => (reads++, strict.login.password));
  const client = new SpatialClient(strict.url, { session });
  assert.equal(reads, 0);
  assert.ok(Array.isArray(await client.uploads()));
  await client.uploads();
  assert.equal(reads, 1);
  const none = new SpatialClient(strict.url, { session: new WebSession(strict.login.username, async () => undefined) });
  await assert.rejects(none.uploads(), /no password stored for admin@example\.org: run `spatial-mcp set-password`/);
  await strict.close();
});

describe("over MCP", () => {
  const open: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of open.splice(0)) await close().catch(() => undefined);
  });
  async function connect(opts: { strict?: boolean; autoBrowse?: boolean; store?: MemoryStore } = {}) {
    const fake = await startFakeSpatial({ acceptToken: idp.validAccessToken, bearerOnAdminPages: !opts.strict });
    const { auth, opened, store } = makeAuth({ autoBrowse: opts.autoBrowse, loginWaitMs: opts.autoBrowse === false ? 50 : 5000, store: opts.store });
    const client = new SpatialClient(fake.url, { auth, apiKey: "service-key" });
    const server = createServer({ client, auth, config: { readonly: false, geoserverUrl: fake.geoserver, pollWaitMs: 1000 }, pollEveryMs: 10 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      const text = r.content[0]!.text;
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: !!r.isError, text, json };
    };
    const close = async () => (await mcp.close(), await fake.close());
    open.push(close);
    return { fake, call, opened, store, close: async () => undefined };
  }

  test("public reads and spatial_health never start a login nor reach the IdP", async () => {
    const c = await connect();
    const before = idp.requests.length;
    assert.equal((await c.call("spatial_list_layers")).isError, false);
    const h = await c.call("spatial_health");
    assert.equal(h.isError, false, h.text);
    assert.equal(h.json.auth.loggedIn, false);
    assert.match(h.json.auth.mode, /OIDC browser login/);
    assert.match(h.json.auth.hint, /spatial_login/);
    assert.match(h.json.admin, /log in/);
    assert.equal(c.opened.length, 0);
    assert.deepEqual(idp.requests.slice(before), [], "no IdP request");
    await c.close();
  });

  test("the first admin call opens the login; health then reports the user and that the admin pages take the token", async () => {
    const c = await connect();
    const r = await c.call("spatial_list_uploads");
    assert.equal(r.isError, false, r.text);
    assert.equal(c.opened.length, 1);
    const h = await c.call("spatial_health");
    assert.equal(h.json.auth.loggedIn, true);
    assert.equal(h.json.auth.user, "admin@example.org");
    assert.deepEqual(h.json.auth.roles, ["ROLE_ADMIN", "ROLE_USER"]);
    assert.equal(h.json.auth.adminPagesAcceptToken, true);
    assert.equal(h.json.admin, "ok");
    assert.ok(!h.text.includes(c.store.value!), "refresh token never shown");
    assert.ok(!/eyJ[A-Za-z0-9_-]+\./.test(h.text), "no JWT shown");
    await c.close();
  });

  test("spatial_login hands back the URL until the user finishes, then who is logged in", async () => {
    const c = await connect({ autoBrowse: false });
    const pending = await c.call("spatial_login");
    assert.equal(pending.json.loggedIn, false);
    assert.equal(pending.json.pendingLogin.url, c.opened[0]);
    assert.match(pending.json.message, /call spatial_login again/);
    await idp.browse(c.opened[0]!);
    const done = await c.call("spatial_login");
    assert.equal(done.json.loggedIn, true);
    assert.equal(done.json.user, "admin@example.org");
    assert.equal((await c.call("spatial_logout")).json.needsConfirmation, true);
    assert.equal((await c.call("spatial_logout", { confirm: true })).json.loggedIn, false);
    await c.close();
  });

  test("spatial-service 3.1.0 (admin pages refuse tokens): API and tasks work, admin pages explain the fallback", async () => {
    const c = await connect({ strict: true });
    await c.call("spatial_login");
    const task = await c.call("spatial_run_task", { name: "AreaReport", input: { area: [{ pid: "777" }] }, dryRun: false, confirm: true });
    assert.equal(task.isError, false, task.text);
    const r = await c.call("spatial_list_uploads");
    assert.equal(r.isError, true);
    assert.match(r.text, /only accepts a web-session login on its admin pages/);
    assert.match(r.text, /spatial-mcp set-password/);
    const h = await c.call("spatial_health");
    assert.equal(h.json.auth.adminPagesAcceptToken, false);
    assert.match(h.json.admin, /refuses OIDC tokens on its admin pages/);
    await c.close();
  });
});
