import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { staticToken } from "../src/auth.ts";
import { startHttp } from "../src/http.ts";
import { createServer } from "../src/server.ts";
import { SpatialClient } from "../src/spatial-client.ts";
import { startFakeSpatial } from "./helpers/fake-spatial.ts";
import { shapefileZip } from "./helpers/shapefile-fixture.ts";

type Fake = Awaited<ReturnType<typeof startFakeSpatial>>;
let fake: Fake;
let dir: string;
let zipPath: string;

before(async () => {
  fake = await startFakeSpatial();
  dir = mkdtempSync(join(tmpdir(), "spatial-mcp-test-"));
  zipPath = join(dir, "regions.zip");
  writeFileSync(zipPath, shapefileZip());
});
after(() => fake.close());

async function connect(opts: { token?: string; readonly?: boolean; fakeServer?: Fake } = {}) {
  const f = opts.fakeServer ?? fake;
  const client = new SpatialClient(f.url, { auth: opts.token ? staticToken(opts.token) : undefined, apiKey: "service-key" });
  const server = createServer({ client, config: { readonly: !!opts.readonly, geoserverUrl: f.geoserver, pollWaitMs: 2000 }, secrets: [opts.token], pollEveryMs: 10 });
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
  return { mcp, call, close: () => mcp.close() };
}

test("lists the tools with read-only/destructive hints", async () => {
  const c = await connect();
  const { tools } = await c.mcp.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["spatial_add_layer", "spatial_verify_layer", "spatial_run_task", "inspect_layer_zip", "spatial_delete"]) assert.ok(byName[n], n);
  assert.equal(byName["spatial_list_layers"]!.annotations?.readOnlyHint, true);
  assert.equal(byName["spatial_delete"]!.annotations?.destructiveHint, true);
  assert.match(byName["spatial_add_layer"]!.description!, /changes spatial-service/);
  await c.close();
});

test("the whole wiki procedure: dry run, add, verify, edit, delete", async () => {
  const c = await connect({ token: fake.adminToken });

  const insp = await c.call("inspect_layer_zip", { path: zipPath });
  assert.equal(insp.json.ok, true);
  assert.equal(insp.json.suggestedSname[0], "NAME");

  const layer = { name: "mcp_poc_regions", displayname: "MCP POC regions", classification1: "Area Management", classification2: "Biodiversity", sname: "NAME" };
  const dry = await c.call("spatial_add_layer", { path: zipPath, ...layer });
  assert.equal(dry.isError, false, dry.text);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.layer.changes.displayname.to, "MCP POC regions");
  assert.equal(fake.state.posts.length, 0, "a dry run sends nothing");

  const noConfirm = await c.call("spatial_add_layer", { path: zipPath, ...layer, dryRun: false });
  assert.equal(noConfirm.isError, true);
  assert.match(noConfirm.text, /confirm:true/);

  const real = await c.call("spatial_add_layer", { path: zipPath, ...layer, dryRun: false, confirm: true });
  assert.equal(real.isError, false, real.text);
  assert.equal(real.json.layerId, "9001");
  assert.deepEqual(real.json.fieldIds, ["cl9001"]);
  assert.equal(real.json.intersectConfigReloaded, true);
  assert.ok(real.json.tasks.every((t: { verdict: string }) => t.verdict === "success"));

  // what reached the server is exactly a browser submission of the live form
  const layerPost = Object.fromEntries(fake.state.posts[0]!.body);
  assert.equal(layerPost["name"], "mcp_poc_regions");
  assert.equal(layerPost["type"], "Contextual");
  assert.equal(layerPost["enabled"], "on");
  assert.ok("licence_level" in layerPost && "raw_id" in layerPost, "form defaults are sent too");
  const fieldPost = Object.fromEntries(fake.state.posts[1]!.body);
  assert.equal(fieldPost["sname"], "NAME");
  assert.equal(fieldPost["namesearch"], "on");
  assert.ok(fake.state.requests.includes("GET /ws/intersect/reloadconfig"));

  const verify = await c.call("spatial_verify_layer", { layerId: "9001", fieldId: "cl9001", lat: 43, lng: -6 });
  assert.equal(verify.json.ok, true, JSON.stringify(verify.json.checks, null, 1));

  const tooLong = await c.call("spatial_update_layer", { id: "9001", displayname: "x".repeat(200), dryRun: false, confirm: true });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.text, /at most 150/);
  const ro = await c.call("spatial_update_layer", { id: "9001", type: "Environmental", dryRun: false, confirm: true });
  assert.match(ro.text, /read-only/);
  const edit = await c.call("spatial_update_layer", { id: "9001", classification2: "Protected areas", dryRun: false, confirm: true });
  assert.equal(edit.isError, false, edit.text);
  assert.deepEqual(edit.json.changed.classification2, { from: "", to: "Protected areas" });

  const del = await c.call("spatial_delete", { id: "9001", kind: "layer" });
  assert.equal(del.json.needsConfirmation, true);
  assert.ok(fake.state.layers.has("9001"));
  const del2 = await c.call("spatial_delete", { id: "9001", kind: "layer", confirm: true });
  assert.equal(del2.isError, false, del2.text);
  assert.ok(!fake.state.layers.has("9001"));
  assert.ok(!fake.state.fields.has("cl9001"));
  await c.close();
});

test("a contextual layer needs sname; a bad zip never reaches the server", async () => {
  const c = await connect({ token: fake.adminToken });
  const r = await c.call("spatial_add_layer", { path: zipPath, name: "x_y" });
  assert.match(r.text, /"sname" is needed.*NAME/);
  const bad = join(dir, "bad.zip");
  writeFileSync(bad, shapefileZip("b", undefined, { omit: [".dbf"] }));
  const before = fake.state.requests.length;
  const r2 = await c.call("spatial_upload", { path: bad, dryRun: false, confirm: true });
  assert.match(r2.text, /fix the zip first/);
  assert.equal(fake.state.requests.length, before);
  const upper = await c.call("spatial_create_layer", { uploadId: "1", name: "Bad Name" });
  assert.match(upper.text, /lowercase/);
  await c.close();
});

test("a failed LayerCreation is reported with a hint, not as success", async () => {
  const failing = await startFakeSpatial({ failTask: "LayerCreation" });
  const c = await connect({ token: failing.adminToken, fakeServer: failing });
  const r = await c.call("spatial_add_layer", { path: zipPath, name: "mcp_poc_fail", sname: "NAME", dryRun: false, confirm: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.layerTasks[0].verdict, "failed");
  assert.match(r.json.next, /LayerCreation failed/);
  assert.equal(failing.state.fields.size, 0, "no field is created on a failed layer");
  await c.close();
  await failing.close();
});

test("fail closed when the live admin form changes (renamed field) and report drift", async () => {
  const drifted = await startFakeSpatial({ formHtml: (kind, html) => (kind === "layer" ? html.replace('name="displayname"', 'name="display_name"') : html) });
  const c = await connect({ token: drifted.adminToken, fakeServer: drifted });
  const r = await c.call("spatial_add_layer", { path: zipPath, name: "mcp_poc_drift", displayname: "Drift", sname: "NAME", dryRun: false, confirm: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /"displayname" is not a field of the form/);
  assert.equal(drifted.state.layers.size, 0);
  const upId = [...drifted.state.uploads.keys()][0]!;
  const contract = await c.call("spatial_form_contract", { kind: "layer", id: upId });
  assert.ok(contract.json.drift.missingInLive.some((s: string) => s.startsWith("displayname:")));
  assert.ok(contract.json.drift.newInLive.some((s: string) => s.startsWith("display_name:")));
  await c.close();
  await drifted.close();
});

test("without admin credentials: public reads work, admin tools explain what is missing", async () => {
  const c = await connect();
  const layers = await c.call("spatial_list_layers");
  assert.equal(layers.isError, false);
  const health = await c.call("spatial_health");
  assert.equal(health.json.version, "3.1.0");
  assert.match(health.json.admin, /not available.*401/);
  const up = await c.call("spatial_list_uploads");
  assert.equal(up.isError, true);
  assert.match(up.text, /admin role/);
  await c.close();
});

test("read-only mode blocks writes but still allows dry runs", async () => {
  const c = await connect({ token: fake.adminToken, readonly: true });
  const dry = await c.call("spatial_create_area", { name: "a", wkt: "POLYGON((0 0,1 0,1 1,0 0))" });
  assert.equal(dry.json.dryRun, true);
  const real = await c.call("spatial_create_area", { name: "a", wkt: "POLYGON((0 0,1 0,1 1,0 0))", dryRun: false, confirm: true });
  assert.match(real.text, /read-only/);
  const del = await c.call("spatial_delete", { id: "1", kind: "upload", confirm: true });
  assert.match(del.text, /read-only/);
  await c.close();
});

test("tasks: run an analysis with a spec check, then poll it", async () => {
  const c = await connect({ token: fake.adminToken });
  const bad = await c.call("spatial_run_task", { name: "AreaReport", input: { nope: 1 }, dryRun: false, confirm: true });
  assert.match(bad.text, /unknown input "nope".*missing input "area"/);
  const dry = await c.call("spatial_run_task", { name: "AreaReport", input: { area: [{ pid: "777" }] } });
  assert.deepEqual(dry.json.problems, []);
  const run = await c.call("spatial_run_task", { name: "AreaReport", input: { area: [{ pid: "777" }] }, dryRun: false, confirm: true });
  const id = run.json.started.id;
  assert.match(run.json.next, /spatial_task_status/);
  assert.equal((await c.call("spatial_task_status", { id })).json.verdict, "running");
  assert.equal((await c.call("spatial_task_status", { id })).json.verdict, "success");
  await c.close();
});

test("secrets never reach the model", async () => {
  const c = await connect({ token: "wrong-token-value" });
  const r = await c.call("spatial_list_uploads");
  assert.equal(r.isError, true);
  assert.ok(!r.text.includes("wrong-token-value"));
  await c.close();
});

test("streamable HTTP transport forwards the caller's bearer token", async () => {
  const http = await startHttp({ url: fake.url, geoserverUrl: fake.geoserver, readonly: false, pollWaitMs: 1000 }, 0);
  const port = (http.address() as { port: number }).port;
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.poc, true);
  for (const [token, expectAdmin] of [[fake.adminToken, true], [undefined, false]] as const) {
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
    const r = (await mcp.callTool({ name: "spatial_list_uploads", arguments: {} })) as { isError?: boolean };
    assert.equal(!r.isError, expectAdmin);
    await mcp.close();
  }
  await new Promise((r) => http.close(r));
});
