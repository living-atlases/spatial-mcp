import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.ts";
import { FormContractError } from "./form-contract.ts";
import { assertLayerZip } from "./paths.ts";
import { Redactor } from "./redact.ts";
import { SpatialClient, SpatialError } from "./spatial-client.ts";
import { summarizeTask } from "./task-outcome.ts";
import { REFERENCE_VERSION, Workflows, type FieldInput, type LayerInput } from "./workflows.ts";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `Experimental proof of concept: an MCP server for routine ALA spatial-service administration.

Workflow for adding a layer (it follows the Living Atlases wiki page "Adding Layers"):
1. inspect_layer_zip on the local zip: fix every error it reports (WGS84, ISO-8859-1 DBF, SHP+SHX+DBF+PRJ or HDR+BIL+PRJ) and
   pick the DBF column that names each object (suggestedSname).
2. spatial_add_layer with dryRun (the default) to preview exactly what the admin form would receive; show it to the user.
3. Only after the user agrees: spatial_add_layer with dryRun:false and confirm:true. It uploads, creates the layer, waits for
   LayerCreation, creates the field, waits for FieldCreation and reloads the intersect config. Long tasks keep running
   on the server: when a result has a "next" hint, follow it (poll spatial_task_status every minute or so; do not loop fast).
4. spatial_verify_layer checks what the wiki's step 8 checks (layers, fields, objects, KML, intersect, GeoServer, admin UI).

Rules:
- Every write is a dry run unless dryRun:false AND confirm:true. Deletes and cancels need confirm:true.
- Writes to the admin UI go through the "form contract": the live admin form is read and only what a person could send
  with that form is sent (maxlength, select options, read-only fields). If it refuses, change the input; do not work around it.
- Admin tools need a user with the admin role (OIDC token). Public read tools work without credentials.
- User analyses (Area report, AOO/EOO, Points to grid, …) run with spatial_run_task; list them with spatial_capabilities.`;

type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

export interface ServerDeps {
  client: SpatialClient;
  config: Pick<Config, "readonly" | "geoserverUrl" | "pollWaitMs">;
  secrets?: Array<string | undefined>;
  pollEveryMs?: number;
}

export function createServer(deps: ServerDeps): McpServer {
  const { client, config } = deps;
  const wf = new Workflows(client, config.geoserverUrl, config.pollWaitMs, deps.pollEveryMs);
  const redactor = new Redactor(deps.secrets ?? []);
  const render = (v: unknown) => (typeof v === "string" ? redactor.str(v) : JSON.stringify(redactor.value(v), null, 2));
  const server = new McpServer({ name: "spatial-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  type Kind = "read" | "write" | "destructive" | "local";
  const tool = <S extends z.ZodRawShape>(name: string, kind: Kind, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) => {
    const annotations = { readOnlyHint: kind === "read" || kind === "local", destructiveHint: kind === "destructive", openWorldHint: kind !== "local" };
    server.registerTool(name, { description: kind === "write" || kind === "destructive" ? `${description} [changes spatial-service]` : description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
      try {
        if ((kind === "write" || kind === "destructive") && config.readonly && !(args as { dryRun?: boolean }).dryRun) throw new Error("this server is read-only (SPATIAL_READONLY): writes are disabled; dry runs still work");
        return { content: [{ type: "text", text: render(await fn(args)) }] };
      } catch (e) {
        const msg = e instanceof FormContractError || e instanceof SpatialError || e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text", text: redactor.str(msg) }] };
      }
    }) as never);
  };

  const dryRun = z.boolean().default(true).describe("Preview only (default). Set false, together with confirm:true, to really do it");
  const confirm = z.boolean().default(false).describe("Must be true (and dryRun false) to really do it");
  const mustConfirm = (a: { dryRun?: boolean; confirm?: boolean }) => {
    if (a.dryRun === false && !a.confirm) throw new Error("dryRun:false needs confirm:true: show the preview to the user and ask first");
    return a.dryRun !== false;
  };
  const confirmOnly = (a: { confirm?: boolean }, what: string) => {
    if (!a.confirm) return { needsConfirmation: true, message: `This will ${what}. Call again with confirm:true once the user has agreed.` };
    return undefined;
  };
  const readZip = (path: string) => readFileSync(assertLayerZip(path));

  const layerShape = {
    name: z.string().describe("Internal name: lowercase a-z, 0-9, _ (max 150, cannot be changed later)"),
    displayname: z.string().optional().describe("Name shown in the portal"),
    description: z.string().optional(),
    type: z.enum(["Contextual", "Environmental"]).optional().describe("Default: what the upload is (shapefile: Contextual, grid: Environmental)"),
    domain: z.string().optional().describe('"Terrestrial", "Marine" or "Terrestrial,Marine"'),
    source: z.string().optional().describe("e.g. organisation name"),
    classification1: z.string().optional().describe("First level of the layer tree in the portal, e.g. Area Management"),
    classification2: z.string().optional().describe("Second level, e.g. Biodiversity"),
    licence_level: z.enum(["1", "2", "3"]).optional(),
    licence_link: z.string().optional(),
    licence_notes: z.string().optional(),
    source_link: z.string().optional(),
    metadatapath: z.string().optional(),
    keywords: z.string().optional(),
    notes: z.string().optional(),
    environmentalvalueunits: z.string().optional().describe("Environmental layers only, e.g. degrees C"),
  };
  const fieldShape = {
    sname: z.string().optional().describe("Contextual: DBF column naming each object (see inspect_layer_zip suggestedSname)"),
    sdesc: z.string().optional().describe("Contextual: DBF column describing each object"),
    fieldName: z.string().optional().describe("Field name (default: the layer display name)"),
    desc: z.string().optional(),
    indb: z.boolean().optional().describe("Include in the biocache (SOLR) index"),
    namesearch: z.boolean().optional().describe("Objects searchable in the gazetteer"),
    intersect: z.boolean().optional().describe("Include in tabulations"),
    defaultlayer: z.boolean().optional(),
  };
  const toField = (a: Record<string, unknown>): FieldInput => {
    const { fieldName, sname, sdesc, desc, indb, namesearch, intersect, defaultlayer } = a as FieldInput & { fieldName?: string };
    return { name: fieldName, sname, sdesc, desc, indb, namesearch, intersect, defaultlayer };
  };
  const toLayer = (a: Record<string, unknown>): LayerInput => Object.fromEntries(Object.keys(layerShape).map((k) => [k, a[k] as string | undefined])) as LayerInput;

  // ---------------- health & discovery ----------------

  tool("spatial_health", "read", "Which spatial-service this server talks to, its version, whether the credentials work (admin endpoints), and drift against the reference version", {}, async () => {
    const out: Record<string, unknown> = { url: client.baseUrl, referenceVersion: REFERENCE_VERSION, readonly: config.readonly };
    try {
      const spec = (await (await client.raw("/openapi/openapi.json")).json()) as { info?: { version?: string } };
      out["version"] = spec.info?.version;
      if (spec.info?.version !== REFERENCE_VERSION) out["warning"] = `this POC was written against spatial-service ${REFERENCE_VERSION}; writes rely on the form contract to stay safe`;
    } catch (e) {
      out["version"] = `unknown (${(e as Error).message})`;
    }
    out["layers"] = (await client.layers()).length;
    try {
      await client.manageLayers();
      out["admin"] = "ok";
    } catch (e) {
      out["admin"] = `not available: ${(e as Error).message}`;
    }
    return out;
  });

  tool("spatial_capabilities", "read", "Tasks (analyses and maintenance processes) this spatial-service can run, with their input specs. Admins see private ones too", {}, async () => {
    const caps = await client.capabilities();
    return Object.entries(caps).map(([name, c]) => ({ name, description: c.description, public: (c.private as { isPublic?: boolean } | undefined)?.isPublic, input: c.input }));
  });

  // ---------------- read (documented API) ----------------

  tool("spatial_list_layers", "read", "Layers, optionally filtered by text (name, display name, classification)", { q: z.string().optional(), limit: z.number().int().default(50) }, async ({ q, limit }) => {
    const all = q ? await client.searchLayers(q) : await client.layers();
    return { total: all.length, layers: all.slice(0, limit).map((l) => ({ id: l.id, name: l.name, displayname: l.displayname, type: l.type, enabled: l.enabled, classification: [l.classification1, l.classification2].filter(Boolean).join(" > ") })) };
  });
  tool("spatial_get_layer", "read", "One layer by id or name", { id: z.string() }, async ({ id }) => client.layer(id));
  tool("spatial_list_fields", "read", "Fields (the sampling/intersect view of layers: cl… contextual, el… environmental), optionally filtered", { q: z.string().optional(), limit: z.number().int().default(50) }, async ({ q, limit }) => {
    const all = q ? await client.searchFields(q) : await client.fields();
    return { total: all.length, fields: all.slice(0, limit).map((f) => ({ id: f.id, name: f.name, layer: f.spid, type: f.type, enabled: f.enabled })) };
  });
  tool("spatial_get_field", "read", "One field by id (e.g. cl22)", { id: z.string() }, async ({ id }) => client.field(id));
  tool("spatial_list_objects", "read", "Objects (polygons, e.g. each state) of a contextual field", { fieldId: z.string(), limit: z.number().int().default(50) }, async ({ fieldId, limit }) => (await client.objects(fieldId, limit)).map((o) => ({ pid: o.pid, name: o.name, id: o.id })));
  tool("spatial_search_gazetteer", "read", "Search objects by name across the gazetteer fields", { q: z.string(), limit: z.number().int().default(20) }, async ({ q, limit }) => client.search(q, limit));
  tool("spatial_intersect", "read", "Values of one or more fields at a point", { fieldIds: z.string().describe("Comma separated, e.g. cl22,el767"), lat: z.number(), lng: z.number() }, async ({ fieldIds, lat, lng }) => client.intersect(fieldIds, lat, lng));

  // ---------------- tasks ----------------

  tool("spatial_task_status", "read", "Status (queued/running/success/failed/cancelled), message and the last log lines of a task", { id: z.number().int() }, async ({ id }) => summarizeTask((await client.taskStatus(id)) as never));
  tool("spatial_list_tasks", "read", "Recent tasks (admin): filter by text or status (0 queued, 1 running, 2 cancelled, 3 failed, 4 finished)", { q: z.string().optional(), status: z.number().int().min(0).max(4).optional(), max: z.number().int().default(20) }, async (a) => client.tasksAll(a));
  tool("spatial_run_task", "write", "Run a task via /tasks/create: a user analysis (AreaReport, AooEoo, PointsToGrid…) or, for admins, a maintenance process (Thumbnails, TabulationCreate, LayerDistancesCreate, StandardizeLayers…). See spatial_capabilities for names and inputs", { name: z.string(), input: z.record(z.unknown()).default({}), dryRun, confirm }, async (a) => {
    const caps = await client.capabilities().catch(() => ({}) as Record<string, never>);
    const spec = (caps as Record<string, { input?: Record<string, { type?: string; constraints?: { optional?: boolean } }> }>)[a.name];
    const problems: string[] = [];
    if (spec?.input) {
      for (const k of Object.keys(a.input)) if (!(k in spec.input)) problems.push(`unknown input "${k}"`);
      for (const [k, v] of Object.entries(spec.input)) if (v.type !== "auto" && !v.constraints?.optional && !(k in a.input)) problems.push(`missing input "${k}" (${v.type})`);
    }
    const preview = { task: a.name, input: a.input, known: !!spec, problems, note: spec ? undefined : "this task is not in the capabilities visible to these credentials (private, or unknown); the server will validate it" };
    if (mustConfirm(a)) return { dryRun: true, ...preview };
    if (problems.length) throw new Error(`refusing to start ${a.name}: ${problems.join("; ")}`);
    const task = await client.createTask(a.name, a.input);
    return { started: task, next: `poll spatial_task_status {id: ${(task as { id?: number }).id}} every minute or so` };
  });
  tool("spatial_cancel_task", "destructive", "Cancel a queued or running task", { id: z.number().int(), confirm }, async (a) => confirmOnly(a, `cancel task ${a.id}`) ?? { result: await client.cancelTask(a.id) });
  tool("spatial_rerun_task", "write", "Re-run a task (admin), e.g. a failed LayerCreation or FieldCreation", { id: z.number().int(), confirm }, async (a) => confirmOnly(a, `re-run task ${a.id}`) ?? (await client.reRunTask(a.id), { rerun: a.id, next: `poll spatial_task_status {id: ${a.id}}` }));

  // ---------------- layers (admin) ----------------

  tool("inspect_layer_zip", "local", "Check a local layer zip before uploading (files present, WGS84, DBF encoding) and list DBF columns with sample values", { path: z.string() }, async ({ path }) => wf.inspect(readZip(path)));

  tool("spatial_list_uploads", "read", "Uploaded files waiting to become layers (admin)", {}, async () => client.uploads());
  tool("spatial_layer_admin", "read", "Admin view of a layer or upload: metadata, its fields and the tasks started for it", { id: z.string().describe("Layer id or upload id") }, async ({ id }) => wf.layerTasks(id));
  tool("spatial_form_contract", "read", "The live admin form for a layer/upload or field: what the UI allows (maxlength, options, read-only), and drift against the reference version", { kind: z.enum(["layer", "field"]), id: z.string() }, async ({ kind, id }) => wf.formContract(kind, id));

  tool("spatial_upload", "write", "Upload a layer zip (wiki step 2). Returns the upload id; then spatial_create_layer", { path: z.string(), dryRun, confirm }, async (a) => {
    const zip = readZip(a.path);
    const inspection = wf.inspect(zip);
    if (!inspection.ok) throw new Error(`fix the zip first: ${inspection.errors.join("; ")}`);
    if (mustConfirm(a)) return { dryRun: true, inspection };
    return { inspection, ...(await wf.upload(zip, a.path)) };
  });

  tool("spatial_create_layer", "write", "Create a layer from an upload (wiki step 3); starts LayerCreation", { uploadId: z.string(), ...layerShape, dryRun, confirm }, async (a) => {
    if (mustConfirm(a)) return { dryRun: true, ...wf.previewLayer(toLayer(a)) };
    return wf.createLayer(a.uploadId, toLayer(a));
  });

  tool("spatial_create_field", "write", "Add a field to a layer (wiki step 5); starts FieldCreation, then reloads the intersect config", { layerId: z.string(), ...fieldShape, dryRun, confirm }, async (a) => {
    if (mustConfirm(a)) return { dryRun: true, ...wf.previewField(toField(a)) };
    return wf.createField(a.layerId, toField(a));
  });

  tool("spatial_add_layer", "write", "Whole wiki procedure in one go: inspect, upload, create layer, wait for LayerCreation, create field, wait for FieldCreation, reload intersect config", { path: z.string(), ...layerShape, ...fieldShape, layerWaitMinutes: z.number().default(10).describe("How long to wait for LayerCreation before handing back"), dryRun, confirm }, async (a) => {
    const zip = readZip(a.path);
    const inspection = wf.inspect(zip);
    if (!inspection.ok) throw new Error(`fix the zip first: ${inspection.errors.join("; ")}`);
    const layer = toLayer(a);
    const field = toField(a);
    if (inspection.kind === "shapefile" && !field.sname) throw new Error(`"sname" is needed for a contextual layer; suggested DBF columns: ${(inspection.suggestedSname ?? []).join(", ")}`);
    if (mustConfirm(a)) return { dryRun: true, inspection, layer: wf.previewLayer(layer), field: wf.previewField(field) };
    const { uploadId } = await wf.upload(zip, a.path);
    const created = await wf.createLayer(uploadId, layer);
    const layerId = created.layerId ?? uploadId;
    const creation = (await wf.layerTasks(uploadId)).tasks.filter((t) => t.name === "LayerCreation").map((t) => t.id);
    const waited = creation.length ? await wf.waitTasks(creation, a.layerWaitMinutes * 60_000) : [];
    if (!waited.length || waited.some((t) => t.verdict !== "success")) {
      return { uploadId, layerId, layerTasks: waited, next: waited.some((t) => t.verdict === "failed") ? "LayerCreation failed: see spatial_task_status for the log" : `LayerCreation still running: poll spatial_task_status, then spatial_create_field {layerId: "${layerId}", sname: "${field.sname ?? ""}"}` };
    }
    const f = await wf.createField(layerId, field);
    return { uploadId, layerTasks: waited, ...f };
  });

  tool("spatial_update_layer", "write", "Edit layer metadata (display name, classification, licence, enabled…). Read-only fields of the form cannot be changed", { id: z.string(), ...Object.fromEntries(Object.entries(layerShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), enabled: z.boolean().optional(), dryRun, confirm } as unknown as z.ZodRawShape, async (a: Record<string, unknown>) => {
    const input = { ...toLayer(a), enabled: a["enabled"] as boolean | undefined };
    if (mustConfirm(a)) return { dryRun: true, current: await wf.formContract("layer", String(a["id"])), wouldSet: input };
    return wf.updateLayer(String(a["id"]), input);
  });

  tool("spatial_update_field", "write", "Edit a field (name, description, flags). Read-only fields of the form cannot be changed", { fieldId: z.string(), ...fieldShape, dryRun, confirm }, async (a) => {
    if (mustConfirm(a)) return { dryRun: true, current: await wf.formContract("field", a.fieldId), wouldSet: toField(a) };
    return wf.updateField(a.fieldId, toField(a));
  });

  tool("spatial_reload_intersect_config", "write", "Reload the intersect configuration so new fields answer /intersect (wiki step 7)", { confirm }, async (a) => confirmOnly(a, "reload the intersect configuration") ?? { result: (await client.reloadIntersectConfig()).slice(0, 500) });

  tool("spatial_verify_layer", "read", "Wiki step 8: check the layer and field in /layers, /fields, /objects, /object, KML, intersect, GeoServer WMS and the admin UI", { layerId: z.string(), fieldId: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }, async ({ layerId, fieldId, lat, lng }) => wf.verifyLayer(layerId, fieldId, lat !== undefined && lng !== undefined ? { lat, lng } : undefined));

  tool("spatial_delete", "destructive", "Delete a layer (numeric id), a field (cl…/el… id) or an upload (upload id)", { id: z.string(), kind: z.enum(["layer", "field", "upload"]), confirm }, async (a) => {
    const c = confirmOnly(a, `permanently delete ${a.kind} ${a.id} (and, for a layer, its fields, GeoServer layer and files)`);
    if (c) return c;
    if (a.kind === "upload") await client.deleteUpload(a.id);
    else await client.deleteLayerOrField(a.id);
    return { deleted: a.id, kind: a.kind };
  });

  tool("spatial_compare_remote", "read", "Compare the layers and fields here with another spatial-service (e.g. https://spatial.ala.org.au/ws)", { remoteUrl: z.string().url() }, async ({ remoteUrl }) => client.remote(remoteUrl));
  tool("spatial_import_from_remote", "write", "Copy a layer or field definition from another spatial-service (/manageLayers/importLayer|importField)", { url: z.string().url().describe("e.g. https://spatial.ala.org.au/ws/layer/123 or …/field/cl22"), kind: z.enum(["layer", "field"]), dryRun, confirm }, async (a) => {
    if (mustConfirm(a)) return { dryRun: true, wouldImport: a.url, as: a.kind };
    return a.kind === "layer" ? client.importLayer(a.url) : client.importField(a.url);
  });

  // ---------------- areas (help "Import > Areas") ----------------

  tool("spatial_create_area", "write", "Create a user area from WKT or GeoJSON (returns its pid, usable in analyses)", { name: z.string(), description: z.string().default(""), wkt: z.string().optional(), geojson: z.record(z.unknown()).optional(), dryRun, confirm }, async (a) => {
    if (!a.wkt === !a.geojson) throw new Error("give exactly one of wkt or geojson");
    if (mustConfirm(a)) return { dryRun: true, name: a.name, geometry: a.wkt ? `WKT (${a.wkt.length} chars)` : "GeoJSON" };
    const r = a.wkt ? await client.createAreaWkt(a.wkt, a.name, a.description) : await client.createAreaGeojson(a.geojson, a.name, a.description);
    if (r.error) throw new Error(r.error);
    return r;
  });
  tool("spatial_delete_area", "destructive", "Delete a user area created with spatial_create_area", { pid: z.string(), confirm }, async (a) => confirmOnly(a, `delete area ${a.pid}`) ?? { result: await client.deleteArea(a.pid) });

  return server;
}
