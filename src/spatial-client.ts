import createClient from "openapi-fetch";
import type { paths } from "./api.gen.ts";
import type { Auth } from "./auth.ts";
import { noAuth } from "./auth.ts";
import type { WebSession } from "./web-session.ts";

export class SpatialError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`spatial-service ${path} -> ${status}${status === 401 || status === 403 ? " (needs a logged-in user with the admin role: configure SPATIAL_TOKEN or the SPATIAL_OIDC_* variables)" : ""}: ${body.slice(0, 500)}`);
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  auth?: Auth;
  /** Used for /tasks/create and /tasks/cancel when there is no user token. */
  apiKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Browser-like login session for the admin pages (@RequireAdmin ignores bearer tokens in 3.x). */
  session?: WebSession;
}

/**
 * spatial-service client.
 * - Documented endpoints (the OpenAPI spec the service publishes at /ws/openapi/openapi.json) go through
 *   openapi-fetch with types generated from that spec (src/api.gen.ts), so a change in the spec breaks
 *   the build instead of the POC.
 * - The admin UI endpoints (/manageLayers/*, not in the spec) are plain requests; writes to them go
 *   through the form contract (see form-contract.ts). They answer with redirects, so redirects are not
 *   followed and the Location header is read instead.
 */
export class SpatialClient {
  readonly api;
  private readonly auth: Auth;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    readonly baseUrl: string,
    private readonly opts: ClientOptions = {},
  ) {
    this.auth = opts.auth ?? noAuth;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.api = createClient<paths>({ baseUrl, fetch: (req: Request) => this.fetchImpl(req) });
    this.api.use({
      onRequest: async ({ request }) => {
        for (const [k, v] of Object.entries(await this.auth.headers())) request.headers.set(k, v);
        if (!request.headers.has("Accept")) request.headers.set("Accept", "application/json");
        return request;
      },
    });
  }

  // ---------- documented API (OpenAPI) ----------

  private async ok<T>(path: string, p: Promise<{ data?: unknown; error?: unknown; response: Response }>): Promise<T> {
    const { data, error, response } = await p;
    if (!response.ok) throw new SpatialError(path, response.status, typeof error === "string" ? error : JSON.stringify(error ?? ""));
    return data as T;
  }

  layers = () => this.ok<Layer[]>("/layers", this.api.GET("/layers"));
  layer = (id: string) => this.ok<Layer>(`/layer/${id}`, this.api.GET("/layer/{id}", { params: { path: { id } } }));
  fields = (q?: string) => this.ok<Field[]>("/fields", this.api.GET("/fields", { params: { query: q ? { q } : {} } }));
  field = (id: string, pageSize = 0) => this.ok<Field>(`/field/${id}`, this.api.GET("/field/{id}", { params: { path: { id }, query: { pageSize } } }));
  searchLayers = (q: string) => this.ok<Layer[]>("/layers/search", this.api.GET("/layers/search", { params: { query: { q } } }));
  searchFields = (q: string) => this.ok<Field[]>("/fields/search", this.api.GET("/fields/search", { params: { query: { q } } }));
  objects = (fid: string, pageSize = 50) => this.ok<SpatialObject[]>(`/objects/${fid}`, this.api.GET("/objects/{fid}", { params: { path: { fid }, query: { pageSize } } }));
  object = (pid: string) => this.ok<SpatialObject>(`/object/${pid}`, this.api.GET("/object/{pid}", { params: { path: { pid: Number(pid) } } }));
  intersect = (ids: string, lat: number, lng: number) => this.ok<unknown[]>(`/intersect/${ids}`, this.api.GET("/intersect/{ids}/{lat}/{lng}", { params: { path: { ids, lat, lng } } }));
  search = (q: string, limit = 20) => this.ok<unknown[]>("/search", this.api.GET("/search", { params: { query: { q, limit } } }));
  capabilities = () => this.ok<Record<string, Capability>>("/tasks/capabilities", this.api.GET("/tasks/capabilities"));
  taskStatus = (id: string | number) => this.ok<Record<string, unknown>>(`/tasks/status/${id}`, this.api.GET("/tasks/status/{id}", { params: { path: { id: String(id) } } }));
  reloadIntersectConfig = () => this.text("/intersect/reloadconfig", { user: true });
  shapeKml = (pid: string) => this.text(`/shapes/kml/${pid}`);

  /**
   * POST /tasks/create. The spec documents a query parameter "inputs", but TasksController.create reads
   * "input" (query) or a JSON body {name, input}; the JSON body is used here.
   */
  async createTask(name: string, input: Record<string, unknown>, extra: { identifier?: string; email?: string } = {}) {
    const res = await this.raw("/tasks/create", { method: "POST", json: { name, input, ...extra }, user: true, apiKey: true });
    const text = await res.text();
    if (!res.ok) throw new SpatialError("/tasks/create", res.status, text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  async cancelTask(id: string | number) {
    const res = await this.raw(`/tasks/cancel/${id}`, { user: true, apiKey: true });
    if (!res.ok) throw new SpatialError(`/tasks/cancel/${id}`, res.status, await res.text());
    return (await res.text()) || "cancelled";
  }

  createAreaWkt = (wkt: string, name: string, description = "") => this.json<{ id?: number; error?: string }>("/shape/upload/wkt", { method: "POST", json: { wkt, name, description }, user: true });
  createAreaGeojson = (geojson: unknown, name: string, description = "") => this.json<{ id?: number; error?: string }>("/shape/upload/geojson", { method: "POST", json: { ...(geojson as object), name, description }, user: true });
  deleteArea = (pid: string) => this.text(`/shape/upload/${pid}`, { method: "DELETE", user: true });

  // ---------- admin UI endpoints (/manageLayers, /tasks admin views), not in the spec ----------

  manageLayers = () => this.json<Record<string, unknown>>("/manageLayers/layers.json", { user: true });
  uploads = () => this.json<Record<string, unknown>>("/manageLayers/uploads.json", { user: true });
  layerJson = (id: string) => this.json<LayerAdmin>(`/manageLayers/layer/${id}.json`, { user: true });
  fieldJson = (id: string) => this.json<Record<string, unknown>>(`/manageLayers/field/${id}.json`, { user: true });
  layerForm = (id: string) => this.html(`/manageLayers/layer/${id}`);
  fieldForm = (id: string) => this.html(`/manageLayers/field/${id}`);
  remote = (remoteUrl: string) => this.json<Record<string, unknown>>(`/manageLayers/remote.json?remoteUrl=${encodeURIComponent(remoteUrl)}`, { user: true });
  importLayer = (url: string) => this.json<Record<string, unknown>>(`/manageLayers/importLayer?url=${encodeURIComponent(url)}`, { user: true });
  importField = (url: string) => this.json<Record<string, unknown>>(`/manageLayers/importField?url=${encodeURIComponent(url)}`, { user: true });
  tasksAll = (q: { q?: string; status?: number; max?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.json<Record<string, unknown>>(`/tasks/all.json?${qs}`, { user: true });
  };

  /** Upload a layer zip. Returns the upload id (the Location of the redirect to /manageLayers/layer/<id>). */
  async upload(zip: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), filename);
    const res = await this.raw("/manageLayers/upload", { method: "POST", body: form, user: true });
    const loc = redirectTarget(res);
    if (!loc) throw new SpatialError("/manageLayers/upload", res.status, await res.text());
    const err = loc.searchParams.get("error");
    if (err) throw new SpatialError("/manageLayers/upload", res.status, err);
    const id = loc.pathname.match(/\/manageLayers\/layer\/([^/?.]+)/)?.[1];
    if (!id) throw new SpatialError("/manageLayers/upload", res.status, `unexpected redirect to ${loc}`);
    return id;
  }

  /** POST a form (as the browser would). Returns the redirect target's query (layer_id, message, error…). */
  async postForm(path: string, body: Array<[string, string]>): Promise<Record<string, string>> {
    const res = await this.raw(path, { method: "POST", body: new URLSearchParams(body), user: true });
    const loc = redirectTarget(res);
    if (!loc) throw new SpatialError(path, res.status, await res.text());
    const q = Object.fromEntries(loc.searchParams);
    if (q["error"]) throw new SpatialError(path, res.status, q["error"]);
    return q;
  }

  /** deleteLayer/<id> removes a field when id is a field id, otherwise the layer (see ManageLayersController.delete). */
  async deleteLayerOrField(id: string): Promise<void> {
    const res = await this.raw(`/manageLayers/deleteLayer/${id}`, { user: true });
    if (!redirectTarget(res) && !res.ok) throw new SpatialError(`/manageLayers/deleteLayer/${id}`, res.status, await res.text());
  }

  async deleteUpload(id: string): Promise<void> {
    const res = await this.raw(`/manageLayers/deleteUpload/${id}`, { user: true });
    if (!redirectTarget(res) && !res.ok) throw new SpatialError(`/manageLayers/deleteUpload/${id}`, res.status, await res.text());
  }

  async reRunTask(id: string | number): Promise<void> {
    const res = await this.raw(`/tasks/reRun/${id}`, { user: true });
    if (!redirectTarget(res) && !res.ok) throw new SpatialError(`/tasks/reRun/${id}`, res.status, await res.text());
  }

  /** GET an absolute URL (GeoServer, …) and report status and content type. */
  async probe(url: string): Promise<{ status: number; contentType: string; bytes: number }> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    const buf = await res.arrayBuffer();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: buf.byteLength };
  }

  // ---------- plumbing ----------

  async raw(path: string, o: { method?: string; json?: unknown; body?: BodyInit; user?: boolean; apiKey?: boolean; accept?: string } = {}): Promise<Response> {
    const url = this.baseUrl + path;
    const send = async () => {
      const headers: Record<string, string> = { Accept: o.accept ?? "application/json" };
      if (o.user) Object.assign(headers, await this.auth.headers());
      if (o.apiKey && this.opts.apiKey && !headers["Authorization"]) headers["apiKey"] = this.opts.apiKey;
      const cookie = o.user ? this.opts.session?.cookieFor(url) : undefined;
      if (cookie) headers["Cookie"] = cookie;
      let body = o.body;
      if (o.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(o.json);
      }
      const res = await this.fetchImpl(url, { method: o.method ?? "GET", headers, body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      if (o.user) this.opts.session?.store(url, res);
      return res;
    };
    const res = await send();
    if (o.user && this.opts.session && this.needsLogin(res)) {
      await this.opts.session.login(`${this.baseUrl}/manageLayers/layers`);
      return send();
    }
    return res;
  }

  /** 401/403, or a redirect away from spatial-service (to the login page). */
  private needsLogin(res: Response): boolean {
    if (res.status === 401 || res.status === 403) return true;
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    return !!loc && new URL(loc, this.baseUrl).origin !== new URL(this.baseUrl).origin;
  }

  private async json<T>(path: string, o: Parameters<SpatialClient["raw"]>[1] = {}): Promise<T> {
    const res = await this.raw(path, o);
    const text = await res.text();
    if (!res.ok) throw new SpatialError(path, res.status, loginHint(res) ?? text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SpatialError(path, res.status, `expected JSON, got: ${text.slice(0, 200)}`);
    }
  }

  private async text(path: string, o: Parameters<SpatialClient["raw"]>[1] = {}): Promise<string> {
    const res = await this.raw(path, { accept: "*/*", ...o });
    const text = await res.text();
    if (!res.ok) throw new SpatialError(path, res.status, loginHint(res) ?? text);
    return text;
  }

  /** Admin HTML page. A redirect here means the login page (not authenticated). */
  private async html(path: string): Promise<string> {
    const res = await this.raw(path, { accept: "text/html", user: true });
    if (res.status >= 300 && res.status < 400) throw new SpatialError(path, 401, `redirected to ${res.headers.get("location")} (not logged in as admin)`);
    const text = await res.text();
    if (!res.ok) throw new SpatialError(path, res.status, text);
    return text;
  }
}

function redirectTarget(res: Response): URL | undefined {
  if (res.status < 300 || res.status >= 400) return undefined;
  const loc = res.headers.get("location");
  return loc ? new URL(loc, res.url || "http://localhost/") : undefined;
}

function loginHint(res: Response): string | undefined {
  if (res.status >= 300 && res.status < 400) return `redirected to ${res.headers.get("location")} (probably the login page: not authenticated)`;
  return undefined;
}

export interface Layer {
  id: number;
  name: string;
  displayname?: string;
  type?: string;
  enabled?: boolean;
  classification1?: string;
  classification2?: string;
  [k: string]: unknown;
}
export interface Field {
  id: string;
  name: string;
  spid?: string;
  type?: string;
  enabled?: boolean;
  sname?: string;
  objects?: SpatialObject[];
  [k: string]: unknown;
}
export interface SpatialObject {
  pid: string;
  id?: string;
  name?: string;
  fid?: string;
  [k: string]: unknown;
}
export interface Capability {
  name?: string;
  description?: string;
  private?: Record<string, unknown>;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface LayerAdmin {
  id?: string;
  layer_id?: string;
  has_layer?: boolean;
  fields?: Array<{ id: string; name?: string; sname?: string; enabled?: boolean }>;
  task?: Array<{ id: number; name: string; status: number; message?: string; created?: string }>;
  columns?: string[];
  [k: string]: unknown;
}
