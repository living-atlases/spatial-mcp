import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { renderGspForm } from "../../scripts/render-gsp.mjs";
import { inspectLayerZip } from "../../src/shapefile.ts";
import { unzipSync } from "fflate";

/**
 * A small stand-in for spatial-service 3.1.0 that behaves like the real one where the POC depends on it:
 * - /manageLayers/* needs "Authorization: Bearer <adminToken>", else 401 JSON (Accept: json) or 302 to login;
 * - upload, layer and field POSTs answer with 302 redirects, like ManageLayersController;
 * - the admin forms are rendered from the real 3.1.0 GSP views (reference/3.1.0/*.gsp);
 * - tasks go 0 -> 1 -> 4 on successive status polls.
 */
export interface FakeState {
  uploads: Map<string, { columns: string[]; kind: string; layerId?: string }>;
  layers: Map<string, Record<string, unknown>>;
  fields: Map<string, Record<string, unknown>>;
  tasks: Map<number, { id: number; name: string; status: number; input: Record<string, string>; polls: number; fail?: boolean }>;
  posts: Array<{ path: string; body: Array<[string, string]> }>;
  requests: string[];
}

const REF = join(import.meta.dirname, "..", "..", "reference", "3.1.0");
const layerGsp = readFileSync(join(REF, "layer.gsp"), "utf8");
const fieldGsp = readFileSync(join(REF, "field.gsp"), "utf8");
const page = (form: string) => `<!DOCTYPE html><html><body><div class="container">${form}</div></body></html>`;

export async function startFakeSpatial(opts: { adminToken?: string; failTask?: string; formHtml?: (kind: string, html: string) => string; bearerOnAdminPages?: boolean } = {}) {
  const adminToken = opts.adminToken ?? "admin-token";
  const login = { username: "admin@example.org", password: "s3cret-pw" };
  const state: FakeState = { uploads: new Map(), layers: new Map(), fields: new Map(), tasks: new Map(), posts: [], requests: [] };
  let nextTask = 1;
  let nextLayer = 9001;
  const addTask = (name: string, input: Record<string, string>) => {
    const t = { id: nextTask++, name, status: 0, input, polls: 0, fail: opts.failTask === name };
    state.tasks.set(t.id, t);
    return t;
  };
  const tasksFor = (value: string) => [...state.tasks.values()].filter((t) => Object.values(t.input).includes(value)).map((t) => ({ id: t.id, name: t.name, status: t.status, message: "" }));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}`);
    const json = (code: number, body: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const redirect = (to: string) => res.writeHead(302, { Location: `${base}${to}` }).end();
    const bearer = req.headers["authorization"] === `Bearer ${adminToken}`;
    const session = /(^|;\s*)JSESSIONID=admin-session(;|$)/.test(req.headers["cookie"] ?? "");
    // Like spatial-service 3.x: @RequireAdmin pages only see the web session; bearer tokens count elsewhere.
    const adminPage = path.startsWith("/ws/manageLayers") || path.startsWith("/ws/tasks/all") || path.startsWith("/ws/tasks/reRun");
    const isAdmin = session || (bearer && (!adminPage || opts.bearerOnAdminPages !== false));

    // ---- a CAS-like login: /cas/login form -> /ws/callback sets the session cookie ----
    if (path === "/cas/login") {
      const service = url.searchParams.get("service") ?? `${base}/`;
      if (req.method === "POST") {
        const f = new URLSearchParams((await readBody(req)).toString());
        if (f.get("execution") === "e1s1" && f.get("_eventId") === "submit" && f.get("username") === login.username && f.get("password") === login.password) {
          return res.writeHead(302, { Location: `${base}/callback?ticket=ST-1&target=${encodeURIComponent(service)}` }).end();
        }
      }
      return res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><title>CAS login</title><form method="post" id="fm1"><input name="username" type="text"/><input name="password" type="password"/><input type="hidden" name="execution" value="e1s1"/><input type="hidden" name="_eventId" value="submit"/><input type="submit" name="submit" value="Login"/></form></html>`);
    }
    if (path === "/ws/callback") return res.writeHead(302, { Location: url.searchParams.get("target")!, "Set-Cookie": "JSESSIONID=admin-session; Path=/ws; HttpOnly" }).end();

    if (path.startsWith("/geoserver/")) return res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from([137, 80, 78, 71]));
    if (!path.startsWith("/ws/")) return res.writeHead(404).end();
    const p = path.slice(3);

    if (p.startsWith("/manageLayers") || p.startsWith("/tasks/all") || p.startsWith("/tasks/reRun")) {
      if (!isAdmin) {
        if ((req.headers["accept"] ?? "").includes("application/json")) return json(401, { error: "Forbidden, user login required!" });
        return res.writeHead(302, { Location: `${origin}/cas/login?service=${encodeURIComponent(base.replace(/\/ws$/, "") + path + url.search)}` }).end();
      }
    }

    // ---- documented API ----
    if (p === "/openapi/openapi.json") return json(200, JSON.parse(readFileSync(join(REF, "openapi.json"), "utf8")));
    if (p === "/layers") return json(200, [...state.layers.values()]);
    if (p === "/layers/search") return json(200, [...state.layers.values()].filter((l) => JSON.stringify(l).toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase())));
    if (p.startsWith("/layer/")) {
      const l = state.layers.get(p.split("/")[2]!) ?? [...state.layers.values()].find((x) => x["name"] === p.split("/")[2]);
      return l ? json(200, l) : json(404, {});
    }
    if (p === "/fields" || p === "/fields/search") return json(200, [...state.fields.values()]);
    if (p.startsWith("/field/")) return state.fields.has(p.split("/")[2]!) ? json(200, state.fields.get(p.split("/")[2]!)) : json(404, {});
    if (p.startsWith("/objects/")) return state.fields.has(p.split("/")[2]!) ? json(200, [{ pid: "501", name: "Norte" }, { pid: "502", name: "Centro" }]) : json(200, []);
    if (p.startsWith("/object/")) return json(200, { pid: p.split("/")[2], name: "Norte" });
    if (p.startsWith("/shapes/kml/")) return res.writeHead(200, { "Content-Type": "application/vnd.google-earth.kml+xml" }).end("<kml><Placemark/></kml>");
    if (p.startsWith("/intersect/reloadconfig")) return isAdmin ? res.writeHead(200).end("reloaded") : json(401, { error: "login required" });
    if (p.startsWith("/intersect/")) return json(200, [{ field: p.split("/")[2], value: "Norte" }]);
    if (p === "/tasks/capabilities") return json(200, { AreaReport: { description: "Area Report - PDF", private: { isPublic: true }, input: { layersServiceUrl: { type: "auto" }, area: { type: "area", constraints: { min: 1 } }, ignoredPages: { type: "list", constraints: { optional: true } } } } });
    if (p.startsWith("/tasks/status/")) {
      const t = state.tasks.get(Number(p.split("/")[3]));
      if (!t) return json(404, {});
      t.polls++;
      t.status = t.polls === 1 ? 1 : t.fail ? 3 : 4;
      return json(200, { id: t.id, name: t.name, status: t.status, message: t.status === 4 ? "finished" : t.status === 3 ? "failed" : "running", history: { "1790000000000": "started", ...(t.status >= 3 ? { "1790000005000": t.status === 4 ? "finished" : "failed: boom" } : {}) } });
    }
    if (p === "/tasks/create" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      if (!isAdmin && req.headers["apikey"] !== "service-key") return json(401, { error: "api key required" });
      return json(200, { id: addTask(body.name, {}).id, name: body.name, status: 0 });
    }
    if (p.startsWith("/tasks/cancel/")) return res.writeHead(200).end("");
    if (p.startsWith("/tasks/all")) return json(200, { data: [...state.tasks.values()], totalCount: state.tasks.size });
    if (p.startsWith("/tasks/reRun/")) return redirect("/tasks/index");
    if (p === "/shape/upload/wkt" && req.method === "POST") return json(200, { id: 777 });

    // ---- admin UI (ManageLayersController) ----
    // like the real views, these two pages only render HTML
    const table = (heads: string[], rows: string[][]) => res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><body><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td> ${c} </td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`);
    if (p === "/manageLayers/layers") return table(["Date added", "Id", "Name", "Display Name", "Enabled"], [...state.layers.values()].map((l) => ["2026-09-24", String(l["id"]), String(l["name"]), String(l["displayname"] ?? ""), String(l["enabled"])]));
    if (p === "/manageLayers/uploads") return table(["Date", "Raw Id", "Filename", "Layer Id"], [...state.uploads.entries()].map(([id, u]) => ["2026-09-24", id, "id.zip", u.layerId ?? ""]));
    if (p === "/manageLayers/upload" && req.method === "POST") {
      const zip = multipartFile(await readBody(req), req.headers["content-type"] ?? "");
      const i = inspectLayerZip(zip);
      if (!i.ok) return redirect(`/manageLayers/uploads?error=${encodeURIComponent("no layer files")}`);
      const id = String(1790000000000 + state.uploads.size);
      state.uploads.set(id, { columns: (i.columns ?? []).map((c) => c.name).concat("the_geom"), kind: i.kind });
      return redirect(`/manageLayers/layer/${id}?message=Upload+successful`);
    }
    let m = p.match(/^\/manageLayers\/layer\/([^/.]+)(\.json)?$/);
    if (m) {
      const id = m[1]!;
      const upload = state.uploads.get(id) ?? [...state.uploads.values()].find((u) => u.layerId === id);
      const layerId = state.layers.has(id) ? id : upload?.layerId;
      const layer = layerId ? state.layers.get(layerId) : undefined;
      if (req.method === "POST") {
        const body = [...new URLSearchParams((await readBody(req)).toString())];
        state.posts.push({ path: p, body });
        const f = Object.fromEntries(body);
        if (!f["name"]) return redirect("/manageLayers/layers?error=name+missing");
        if (layer) {
          Object.assign(layer, f, { enabled: f["enabled"] === "on" });
          return redirect(`/manageLayers/layers?layer_id=${layerId}&message=Layer+updated`);
        }
        const newId = String(nextLayer++);
        state.layers.set(newId, { id: Number(newId), name: f["name"], displayname: f["displayname"], type: f["type"], enabled: f["enabled"] === "on", classification1: f["classification1"] });
        if (upload) upload.layerId = newId;
        addTask("LayerCreation", { layerId: newId, uploadId: id });
        return redirect(`/manageLayers/layers?layer_id=${newId}&message=Layer+creation+task+started`);
      }
      const model = { id: layerId ?? id, raw_id: layerId ?? "", has_layer: !!layer, layer_id: layerId, type: upload?.kind === "grid" ? "Environmental" : "Contextual", domain: "Terrestrial", enabled: true, licence_level: 1, classifications: ["Area Management > Biodiversity"], ...(layer ?? {}) };
      if (m[2]) return json(200, { ...model, fields: [...state.fields.values()].filter((x) => x["spid"] === layerId), task: layerId ? tasksFor(layerId) : [] });
      const html = page(renderGspForm(layerGsp, model));
      return res.writeHead(200, { "Content-Type": "text/html" }).end(opts.formHtml ? opts.formHtml("layer", html) : html);
    }
    m = p.match(/^\/manageLayers\/field\/([^/.]+)(\.json)?$/);
    if (m) {
      const id = m[1]!;
      const field = state.fields.get(id);
      const layerId = field ? String(field["spid"]) : id;
      const upload = [...state.uploads.values()].find((u) => u.layerId === layerId);
      if (req.method === "POST") {
        const body = [...new URLSearchParams((await readBody(req)).toString())];
        state.posts.push({ path: p, body });
        const f = Object.fromEntries(body);
        if (field) {
          Object.assign(field, f);
          return redirect("/manageLayers/layers");
        }
        const fid = `cl${layerId}`;
        state.fields.set(fid, { id: fid, name: f["name"], spid: layerId, sname: f["sname"], type: "c", enabled: true, namesearch: f["namesearch"] === "on" });
        addTask("FieldCreation", { fieldId: fid });
        return redirect("/manageLayers/layers");
      }
      const model = field ? { ...field, has_layer: true } : { id: layerId, name: state.layers.get(layerId)?.["displayname"], type: "c", columns: upload?.columns ?? [], indb: true, namesearch: true, defaultlayer: true, intersect: false };
      if (m[2]) return json(200, { ...model, layer_id: layerId, task: field ? tasksFor(id) : [] });
      const html = page(renderGspForm(fieldGsp, model));
      return res.writeHead(200, { "Content-Type": "text/html" }).end(opts.formHtml ? opts.formHtml("field", html) : html);
    }
    m = p.match(/^\/manageLayers\/delete(Layer|Upload)\/(.+)$/);
    if (m) {
      const id = m[2]!;
      if (state.fields.delete(id)) return redirect("/manageLayers/layers");
      state.layers.delete(id);
      state.uploads.delete(id);
      for (const [k, f] of state.fields) if (f["spid"] === id) state.fields.delete(k);
      return redirect(m[1] === "Layer" ? "/manageLayers/layers" : "/manageLayers/uploads");
    }
    json(404, { error: `fake: no route for ${req.method} ${path}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;
  const base = `${origin}/ws`;
  return { url: base, geoserver: `${origin}/geoserver`, adminToken, login, state, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function multipartFile(body: Buffer, contentType: string): Uint8Array {
  const boundary = contentType.match(/boundary=(.+)$/)?.[1];
  if (!boundary) return new Uint8Array();
  const start = body.indexOf("\r\n\r\n") + 4;
  const end = body.indexOf(`\r\n--${boundary}`, start);
  const file = new Uint8Array(body.subarray(start, end));
  try {
    unzipSync(file);
  } catch {
    return new Uint8Array();
  }
  return file;
}
