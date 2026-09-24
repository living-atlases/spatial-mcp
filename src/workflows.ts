import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSubmission, parseForm, signature, type FormField, type FormValue } from "./form-contract.ts";
import { inspectLayerZip, type ZipInspection } from "./shapefile.ts";
import type { SpatialClient } from "./spatial-client.ts";
import { summarizeTask, type TaskSummary } from "./task-outcome.ts";

/** Reference admin forms of the spatial-service version this POC was written against (dry-run previews). */
export const REFERENCE_VERSION = "3.1.0";
const refDir = join(dirname(fileURLToPath(import.meta.url)), "..", "reference", REFERENCE_VERSION);
const reference = (name: string) => parseForm(readFileSync(join(refDir, name), "utf8"));
export const referenceForms = {
  layerNew: () => reference("layer-new.html"),
  layerExisting: () => reference("layer-existing.html"),
  fieldNew: () => reference("field-new.html"),
};

export interface LayerInput {
  name: string;
  displayname?: string;
  description?: string;
  type?: "Contextual" | "Environmental";
  domain?: string;
  source?: string;
  classification1?: string;
  classification2?: string;
  licence_level?: string;
  licence_link?: string;
  licence_notes?: string;
  source_link?: string;
  metadatapath?: string;
  keywords?: string;
  notes?: string;
  environmentalvalueunits?: string;
  [k: string]: FormValue;
}

export interface FieldInput {
  name?: string;
  desc?: string;
  sname?: string;
  sdesc?: string;
  type?: string;
  indb?: boolean;
  namesearch?: boolean;
  defaultlayer?: boolean;
  intersect?: boolean;
  [k: string]: FormValue;
}

const LAYER_NAME = /^[a-z0-9_]+$/;

export function checkLayerName(name: string) {
  if (!LAYER_NAME.test(name)) throw new Error(`layer name "${name}" must be lowercase a-z, 0-9 and _ only (the admin form says so; it is used internally)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Workflows {
  constructor(
    readonly client: SpatialClient,
    readonly geoserverUrl = geoserverFrom(client.baseUrl),
    readonly pollWaitMs = 20_000,
    readonly pollEveryMs = 3_000,
  ) {}

  /** Poll tasks until all are done or `maxMs` passes. */
  async waitTasks(ids: Array<number | string>, maxMs = this.pollWaitMs): Promise<TaskSummary[]> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const out = await Promise.all(ids.map(async (id) => summarizeTask((await this.client.taskStatus(id)) as never)));
      if (out.every((t) => t.done) || Date.now() >= deadline) return out;
      await sleep(Math.min(this.pollEveryMs, Math.max(0, deadline - Date.now())));
    }
  }

  /** Tasks started for a layer (LayerCreation, FieldCreation, …) as listed by /manageLayers/layer/<id>.json. */
  async layerTasks(id: string) {
    const j = await this.client.layerJson(id);
    return { admin: j, tasks: (j.task ?? []).map((t) => ({ id: t.id, name: t.name, verdict: summarizeTask({ status: t.status }).verdict, message: t.message })) };
  }

  /** Live form contract of an admin page, compared with the reference one. */
  async formContract(kind: "layer" | "field", id: string) {
    const live = parseForm(kind === "layer" ? await this.client.layerForm(id) : await this.client.fieldForm(id));
    const has = live.some((f) => f.name === "name" && f.readonly);
    const ref = kind === "field" ? referenceForms.fieldNew() : has ? referenceForms.layerExisting() : referenceForms.layerNew();
    return { fields: live, drift: diff(signature(ref), signature(live)) };
  }

  // ---------- layers (LA wiki "Adding Layers", steps 1-7) ----------

  inspect(zip: Uint8Array): ZipInspection {
    return inspectLayerZip(zip);
  }

  async upload(zip: Uint8Array, filename: string) {
    const uploadId = await this.client.upload(zip, basename(filename));
    return { uploadId, next: `create the layer: spatial_create_layer {uploadId: "${uploadId}", name, displayname, ...}` };
  }

  previewLayer(input: LayerInput) {
    checkLayerName(input.name);
    return { contract: `reference form of spatial-service ${REFERENCE_VERSION}`, ...buildSubmission(referenceForms.layerNew(), input) };
  }

  async createLayer(uploadId: string, input: LayerInput) {
    checkLayerName(input.name);
    const form = parseForm(await this.client.layerForm(uploadId));
    const sub = buildSubmission(form, input);
    const q = await this.client.postForm(`/manageLayers/layer/${uploadId}`, sub.body);
    const { tasks } = await this.layerTasks(uploadId);
    const ids = tasks.filter((t) => t.name === "LayerCreation").map((t) => t.id);
    const waited = ids.length ? await this.waitTasks(ids) : [];
    return {
      uploadId,
      layerId: q["layer_id"],
      message: q["message"],
      sent: sub.changes,
      tasks: waited.length ? waited : tasks,
      next: waited.every((t) => t.verdict === "success") && waited.length
        ? `LayerCreation finished: add a field with spatial_create_field {layerId: "${q["layer_id"] ?? uploadId}", sname: <DBF column>}`
        : `LayerCreation is still running: poll spatial_task_status {id: ${ids[0] ?? "?"}} every minute, then spatial_create_field`,
    };
  }

  async updateLayer(id: string, input: Partial<LayerInput>) {
    const form = parseForm(await this.client.layerForm(id));
    const sub = buildSubmission(form, input);
    if (Object.keys(sub.changes).length === 0) return { unchanged: true };
    const q = await this.client.postForm(`/manageLayers/layer/${id}`, sub.body);
    return { id, changed: sub.changes, message: q["message"] };
  }

  previewField(input: FieldInput) {
    return { contract: `reference form of spatial-service ${REFERENCE_VERSION} (sname options are the DBF columns of the real upload)`, ...buildSubmission(referenceForms.fieldNew().map(relaxDynamic), input) };
  }

  /** Add a field to a layer (POST /manageLayers/field/<layerId>): starts FieldCreation (or StandardizeLayers). */
  async createField(layerId: string, input: FieldInput) {
    const before = new Set((await this.client.layerJson(layerId)).fields?.map((f) => f.id) ?? []);
    const form = parseForm(await this.client.fieldForm(layerId));
    if (form.find((f) => f.name === "type")?.value === "c" && !input.sname) {
      const cols = form.find((f) => f.name === "sname")?.options?.filter(Boolean) ?? [];
      throw new Error(`a contextual field needs "sname", the DBF column that names each object; columns: ${cols.join(", ")}`);
    }
    const sub = buildSubmission(form, input);
    await this.client.postForm(`/manageLayers/field/${layerId}`, sub.body);
    const after = await this.client.layerJson(layerId);
    const fieldIds = (after.fields ?? []).map((f) => f.id).filter((id) => !before.has(id));
    // FieldCreation's input is the field id, so its tasks are listed on the field page, not the layer's.
    const fieldTasks = (await Promise.all(fieldIds.map(async (id) => ((await this.client.fieldJson(id)).task ?? []) as NonNullable<typeof after.task>))).flat();
    const ids = [...fieldTasks, ...(after.task ?? [])].filter((t) => ["FieldCreation", "StandardizeLayers"].includes(t.name) && t.status < 2).map((t) => t.id).filter((id, i, a) => a.indexOf(id) === i);
    const waited = ids.length ? await this.waitTasks(ids) : [];
    const done = waited.length > 0 && waited.every((t) => t.verdict === "success");
    if (done) await this.client.reloadIntersectConfig().catch(() => undefined);
    return {
      layerId,
      fieldIds,
      sent: sub.changes,
      tasks: waited,
      intersectConfigReloaded: done,
      next: done
        ? `check it: spatial_verify_layer {layerId: "${layerId}", fieldId: "${fieldIds[0] ?? "?"}"}`
        : `FieldCreation is still running: poll spatial_task_status, then spatial_reload_intersect_config and spatial_verify_layer`,
    };
  }

  async updateField(fieldId: string, input: FieldInput) {
    const form = parseForm(await this.client.fieldForm(fieldId));
    const sub = buildSubmission(form, input);
    if (Object.keys(sub.changes).length === 0) return { unchanged: true };
    await this.client.postForm(`/manageLayers/field/${fieldId}`, sub.body);
    return { fieldId, changed: sub.changes };
  }

  // ---------- LA wiki "Adding Layers", step 8 ----------

  async verifyLayer(layerId: string, fieldId?: string, point?: { lat: number; lng: number }) {
    const checks: Array<{ check: string; ok: boolean; detail?: unknown }> = [];
    const run = async (check: string, fn: () => Promise<unknown>) => {
      try {
        const detail = await fn();
        checks.push({ check, ok: detail !== false, detail });
      } catch (e) {
        checks.push({ check, ok: false, detail: (e as Error).message });
      }
    };
    const layer = await this.client.layer(layerId).catch(() => undefined);
    await run("layer is listed in /layers", async () => {
      const all = await this.client.layers();
      const l = all.find((x) => String(x.id) === String(layerId) || x.name === layerId);
      return l ? { id: l.id, name: l.name, enabled: l.enabled } : false;
    });
    if (fieldId) {
      await run("field is listed in /fields", async () => ((await this.client.fields()).some((f) => f.id === fieldId) ? true : false));
      let firstPid: string | undefined;
      await run("field has objects (/objects/<fid>)", async () => {
        const objs = await this.client.objects(fieldId, 5);
        firstPid = objs[0]?.pid;
        return objs.length ? objs.map((o) => o.name) : false;
      });
      if (firstPid) {
        await run("object details (/object/<pid>)", async () => ((await this.client.object(firstPid!)).pid ? true : false));
        await run("object KML (/shapes/kml/<pid>)", async () => ((await this.client.shapeKml(firstPid!)).includes("<kml") ? true : false));
      }
      if (point) await run(`intersect at ${point.lat},${point.lng}`, async () => this.client.intersect(fieldId, point.lat, point.lng));
    }
    if (layer?.name) {
      const wms = `${this.geoserverUrl}/ALA/wms?service=WMS&version=1.1.0&request=GetMap&layers=ALA:${encodeURIComponent(String(layer.name))}&styles=&bbox=-180,-90,180,90&width=256&height=128&srs=EPSG:4326&format=image/png`;
      await run("GeoServer WMS GetMap renders the layer", async () => {
        const p = await this.client.probe(wms);
        return p.status === 200 && p.contentType.startsWith("image/") ? p : false;
      });
    }
    await run("admin UI page renders (manageLayers/layer)", async () => (parseForm(await this.client.layerForm(layerId)).length > 0 ? true : false));
    return { ok: checks.every((c) => c.ok), checks };
  }
}

function relaxDynamic(f: FormField): FormField {
  // In a preview the DBF columns are unknown: accept any sname/sdesc.
  return f.name === "sname" || f.name === "sdesc" ? { ...f, kind: "text", options: undefined } : f;
}

function diff(ref: string[], live: string[]) {
  const onlyRef = ref.filter((x) => !live.includes(x));
  const onlyLive = live.filter((x) => !ref.includes(x));
  return onlyRef.length || onlyLive.length ? { referenceVersion: REFERENCE_VERSION, missingInLive: onlyRef, newInLive: onlyLive } : null;
}

export function geoserverFrom(wsUrl: string) {
  return new URL("/geoserver", wsUrl).toString().replace(/\/$/, "");
}
