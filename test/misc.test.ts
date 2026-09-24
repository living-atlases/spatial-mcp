import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, renderGspForm } from "../scripts/render-gsp.mjs";
import { loadConfig, secretsOf } from "../src/config.ts";
import { Redactor } from "../src/redact.ts";
import { htmlTable } from "../src/spatial-client.ts";
import { summarizeTask } from "../src/task-outcome.ts";

test("task verdicts follow Task.groovy (0 queued .. 4 finished) and the log is ordered", () => {
  const s = summarizeTask({ id: 5, name: "FieldCreation", status: 3, message: "failed", history: { "1790000005000": "failed: boom", "1790000000000": "started" } });
  assert.equal(s.verdict, "failed");
  assert.equal(s.done, true);
  assert.match(s.log[0]!, /started$/);
  assert.equal(summarizeTask({ status: 1 }).done, false);
  assert.equal(summarizeTask({ status: 4 }).verdict, "success");
});

test("redactor masks configured secrets, bearer tokens and secret-named fields", () => {
  const r = new Redactor(["s3cr3t-pass"]);
  assert.equal(r.str("login s3cr3t-pass failed, header Bearer abc.def.ghi"), "login *** failed, header Bearer ***");
  assert.deepEqual(r.value({ apiKey: "k", nested: { password: "p", ok: 1 } }), { apiKey: "***", nested: { password: "***", ok: 1 } });
});

test("config: flags win over env, OIDC needs an issuer or a token URL", () => {
  const c = loadConfig(["--spatial", "https://s.example/ws/"], { SPATIAL_URL: "https://other/ws", SPATIAL_TOKEN: "t", SPATIAL_READONLY: "yes" });
  assert.equal(c.url, "https://s.example/ws");
  assert.equal(c.geoserverUrl, "https://s.example/geoserver");
  assert.equal(c.readonly, true);
  assert.deepEqual(secretsOf(c).filter(Boolean), ["t"]);
  assert.throws(() => loadConfig([], { SPATIAL_OIDC_CLIENT_ID: "x" }), /ISSUER/);
});

test("the GSP renderer understands the expressions the manageLayers views use", () => {
  assert.equal(evaluate("layer_creation != null || has_layer", { has_layer: true }), true);
  assert.equal(evaluate("layer_creation == null && !has_layer", {}), true);
  assert.equal(evaluate("licence_level == 1", { licence_level: "1" }), true);
  assert.equal(evaluate('has_layer ? "Update Layer" : "Create Layer"', { has_layer: false }), "Create Layer");
  const html = renderGspForm('<p><form method="POST"><g:if test="${a}"><input name="x" value="${v}"/></g:if><g:each in="${cols}" var="c"><option value="${c}"/></g:each></form></p>', { a: true, v: 'a"b', cols: ["A", "B"] });
  assert.equal(html, '<form method="POST"><input name="x" value="a&quot;b"/><option value="A"/><option value="B"/></form>');
});

test("admin list pages are read from their HTML table", () => {
  const rows = htmlTable("<table><thead><tr><th>Id</th><th>Name</th><th></th></tr></thead><tbody><tr><td> 12 </td><td>comarcas\n x</td><td><a>Edit</a></td></tr><tr><td></td></tr></tbody></table>");
  assert.deepEqual(rows, [{ Id: "12", Name: "comarcas x", col2: "Edit" }]);
});
