import assert from "node:assert/strict";
import { test } from "node:test";
import { OidcAuth, noAuth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { InteractiveOidcAuth } from "../src/oidc-auth.ts";
import { authFor, cli, sessionFor } from "../src/stdio.ts";

const base = { SPATIAL_URL: "https://spatial.example.org/ws", SPATIAL_TOKEN_STORE: "file", XDG_CONFIG_HOME: "/nonexistent-spatial-mcp-test" };

test("authFor: a bare public client is the user's OIDC login; a secret keeps the machine grant", () => {
  assert.ok(authFor(loadConfig([], { ...base, SPATIAL_OIDC_ISSUER: "https://auth.example.org/cas/oidc", SPATIAL_OIDC_CLIENT_ID: "spatial-mcp" })) instanceof InteractiveOidcAuth);
  assert.ok(authFor(loadConfig([], { ...base, SPATIAL_OIDC_ISSUER: "https://auth.example.org/cas/oidc", SPATIAL_OIDC_CLIENT_ID: "ci", SPATIAL_OIDC_CLIENT_SECRET: "s" })) instanceof OidcAuth);
  assert.equal(authFor(loadConfig([], base)), noAuth);
});

test("sessionFor: only with SPATIAL_USERNAME; the password is not read until a login needs it", () => {
  assert.equal(sessionFor(loadConfig([], base)), undefined);
  assert.ok(sessionFor(loadConfig([], { ...base, SPATIAL_USERNAME: "admin@example.org" })));
});

test("terminal commands fail clearly without what they need", async () => {
  await assert.rejects(cli("set-password", loadConfig([], base)), /SPATIAL_USERNAME/);
  await assert.rejects(cli("login", loadConfig([], base)), /SPATIAL_OIDC_ISSUER and SPATIAL_OIDC_CLIENT_ID/);
  if (!process.stdin.isTTY) await assert.rejects(cli("set-password", loadConfig([], { ...base, SPATIAL_USERNAME: "admin@example.org" })), /interactive terminal/);
});
