/**
 * Integration tests against a real spatial-service (the LA demo stack deployed by the Jenkins job
 * la-docker-compose-tests). Configure with:
 *   SPATIAL_TEST_URL=https://spatial.l-a.site/ws
 *   admin (for the write tests): SPATIAL_USERNAME + SPATIAL_PASSWORD of a portal admin (the admin pages need a
 *   browser-like login session); optionally SPATIAL_OIDC_* for a bearer token on /tasks/create
 *
 * The write test creates a layer named mcp_poc_<timestamp> from a 3-polygon WGS84 shapefile, waits for
 * LayerCreation and FieldCreation (not for the tabulation chain), checks it the way the wiki's step 8 does,
 * checks that the admin UI pages still render it, and deletes it in a finally block.
 * With SPATIAL_TEST_KEEP_LAYER=1 it also adds mcp_demo_regions and mcp_demo_ccaa and leaves them there.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, secretsOf } from "../../src/config.ts";
import { parseForm, signature } from "../../src/form-contract.ts";
import { createServer } from "../../src/server.ts";
import { SpatialClient } from "../../src/spatial-client.ts";
import { clientFor } from "../../src/stdio.ts";
import { referenceForms, REFERENCE_VERSION } from "../../src/workflows.ts";
import { shapefileZip } from "../helpers/shapefile-fixture.ts";

const URL_ = process.env["SPATIAL_TEST_URL"];
const config = URL_ ? loadConfig(["--spatial", URL_]) : undefined;
const hasAdmin = !!config?.login;
const TASK_TIMEOUT = Number(process.env["SPATIAL_TEST_TASK_TIMEOUT_MS"] ?? 15 * 60_000);

describe("spatial-service (real)", { skip: !URL_ && "SPATIAL_TEST_URL not set" }, () => {
  let client: SpatialClient;
  let call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;
  let mcp: Client;

  before(async () => {
    client = clientFor(config!);
    const server = createServer({ client, config: { ...config!, pollWaitMs: TASK_TIMEOUT }, secrets: secretsOf(config!), pollEveryMs: 10_000 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: "integration", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    call = async (name, args = {}) => {
      const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: TASK_TIMEOUT * 3 })) as { isError?: boolean; content: Array<{ text: string }> };
      const text = r.content[0]!.text;
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {}
      return { isError: !!r.isError, text, json };
    };
  });
  after(() => mcp?.close());

  test(`published OpenAPI spec matches the reference ${REFERENCE_VERSION} (paths and parameters)`, async () => {
    const live = (await (await client.raw("/openapi/openapi.json")).json()) as Spec;
    const ref = JSON.parse(readFileSync(new URL(`../../reference/${REFERENCE_VERSION}/openapi.json`, import.meta.url), "utf8")) as Spec;
    assert.deepEqual(specShape(live), specShape(ref));
  });

  test("public reads", async () => {
    const h = await call("spatial_health");
    assert.equal(h.isError, false, h.text);
    const fields = await call("spatial_list_fields", { limit: 5 });
    assert.equal(fields.isError, false, fields.text);
    assert.ok(fields.json.total >= 0);
    const layers = await call("spatial_list_layers", { limit: 5 });
    assert.equal(layers.isError, false, layers.text);
  });

  test("admin endpoints refuse anonymous callers (spatial-service 3.x: an API key alone is not enough)", async () => {
    const anon = new SpatialClient(config!.url, { apiKey: config!.apiKey });
    await assert.rejects(anon.manageLayers(), /401|403|login/);
  });

  describe("as admin", { skip: !hasAdmin && "no admin account (SPATIAL_USERNAME/SPATIAL_PASSWORD)" }, () => {
    test("admin access works", async () => {
      const h = await call("spatial_health");
      assert.equal(h.json.admin, "ok", h.text);
    });

    test("add a layer the way the wiki does, verify it, check the admin UI, delete it", async () => {
      const name = `mcp_poc_${Date.now()}`;
      const dir = mkdtempSync(join(tmpdir(), "spatial-mcp-it-"));
      const zip = join(dir, `${name}.zip`);
      writeFileSync(zip, shapefileZip(name));
      let uploadId: string | undefined;
      let layerId: string | undefined;
      try {
        const r = await call("spatial_add_layer", { path: zip, name, displayname: `MCP POC ${name.slice(8)}`, classification1: "MCP POC", classification2: "Test", sname: "NAME", layerWaitMinutes: TASK_TIMEOUT / 60_000, dryRun: false, confirm: true });
        uploadId = r.json?.uploadId ?? r.text.match(/\(upload (\d+)\)/)?.[1];
        assert.equal(r.isError, false, r.text);
        layerId = r.json.layerId;
        assert.ok(layerId, r.text);
        assert.ok(r.json.layerTasks.every((t: { verdict: string }) => t.verdict === "success"), r.text);
        assert.equal(r.json.fieldIds.length, 1, r.text);
        assert.ok(r.json.tasks.every((t: { verdict: string }) => t.verdict === "success"), r.text);
        const fieldId = r.json.fieldIds[0];

        // form drift: the live forms have the shape of the reference ones
        const layerForm = parseForm(await client.layerForm(layerId!));
        assert.deepEqual(signature(layerForm), signature(referenceForms.layerExisting()));
        const fieldForm = parseForm(await client.fieldForm(fieldId));
        assert.ok(fieldForm.some((f) => f.name === "sname"));

        // wiki step 8 (+ GeoServer and the admin UI page)
        // Point intersect of a new field only works after a spatial-service restart in 3.1.0 (DEVELOPMENT.md
        // finding 9): accept that failure, but only with the message that explains it.
        const v = await call("spatial_verify_layer", { layerId, fieldId, lat: 43, lng: -6 });
        const failed = v.json.checks.filter((c: { ok: boolean; check: string; detail: unknown }) => !c.ok && !(c.check.startsWith("intersect") && /restart spatial-service/.test(String(c.detail))));
        assert.deepEqual(failed, [], JSON.stringify(v.json.checks, null, 1));

        // the admin UI lists it (what a person sees)
        const list = await client.raw("/manageLayers/layers", { accept: "text/html", user: true });
        assert.equal(list.status, 200);
        assert.match(await list.text(), new RegExp(name));

        // editing through the contract works and read-only fields stay read-only
        const ro = await call("spatial_update_layer", { id: layerId, type: "Environmental", dryRun: false, confirm: true });
        assert.match(ro.text, /read-only/);
        const edit = await call("spatial_update_layer", { id: layerId, classification2: "Test edited", dryRun: false, confirm: true });
        assert.equal(edit.isError, false, edit.text);
        assert.equal((await client.layer(layerId!)).classification2, "Test edited");
      } finally {
        if (layerId) await call("spatial_delete", { id: layerId, kind: "layer", confirm: true });
        if (uploadId && uploadId !== layerId) await call("spatial_delete", { id: uploadId, kind: "upload", confirm: true });
      }
      if (layerId) assert.ok(!(await client.layers()).some((l) => String(l.id) === String(layerId)), "cleaned up");
    });

    // Demo layers left on the stack (for demos/screenshots): the synthetic regions and a real one, Spain's
    // autonomous communities from Natural Earth (public domain; accented names in an ISO-8859-1 DBF).
    const demos = [
      { name: "mcp_demo_regions", zip: () => shapefileZip("mcp_demo_regions"), displayname: "MCP demo regions", description: "Synthetic regions added by spatial-mcp (POC)", classification2: "Demo" },
      { name: "mcp_demo_ccaa", zip: () => readFileSync(new URL("../fixtures/mcp_demo_ccaa.zip", import.meta.url)), displayname: "Comunidades autónomas de España (MCP demo)", description: "Spain's autonomous communities, Natural Earth 1:10m admin-1 (public domain), added by spatial-mcp (POC)", classification2: "Political" },
    ];
    for (const d of demos)
      test(`keep a demo layer (${d.name})`, { skip: !process.env["SPATIAL_TEST_KEEP_LAYER"] && "SPATIAL_TEST_KEEP_LAYER not set" }, async () => {
        if ((await client.layers()).some((l) => l.name === d.name)) return;
        const dir = mkdtempSync(join(tmpdir(), "spatial-mcp-demo-"));
        const zip = join(dir, `${d.name}.zip`);
        writeFileSync(zip, d.zip());
        const r = await call("spatial_add_layer", { path: zip, name: d.name, displayname: d.displayname, description: d.description, classification1: "MCP POC", classification2: d.classification2, sname: "NAME", layerWaitMinutes: TASK_TIMEOUT / 60_000, dryRun: false, confirm: true });
        assert.equal(r.isError, false, r.text);
        console.log(`demo layer ${d.name}: layer ${r.json.layerId}, field ${r.json.fieldIds?.[0]}`);
      });
  });
});

type Spec = { paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; required?: boolean }> }>> };
function specShape(s: Spec) {
  return Object.entries(s.paths)
    .flatMap(([p, ops]) => Object.entries(ops).filter(([, o]) => typeof o === "object" && o).map(([m, o]) => `${m.toUpperCase()} ${p} ${(o.parameters ?? []).map((x) => `${x.in}:${x.name}${x.required ? "*" : ""}`).sort().join(",")}`))
    .sort();
}
