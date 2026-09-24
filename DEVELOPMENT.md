# Development notes (POC)

## What this is, and what it should become

A proof of concept to answer: *can an agent do routine Spatial Portal administration without breaking anything?*
It talks to spatial-service over HTTP and does not modify it. If the answer is yes, the useful outcome is less
this repo than a list of small changes to spatial-service that would make automation safe by design (below).

Written against **spatial-service 3.1.0** (Grails 6), the version the LA demo stack runs.

## How it works

```
MCP client ──stdio or Streamable HTTP──▶ spatial-mcp ──HTTP──▶ spatial-service /ws
                                             │                    ├─ documented API (OpenAPI)      → openapi-fetch, types from the spec
                                             │                    └─ /manageLayers/* (admin pages) → form contract
                                             └─ local: zip inspection (SHP/SHX/DBF/PRJ, WGS84, DBF encoding)
```

- `src/api.gen.ts` is generated from `reference/3.1.0/openapi.json` (`npm run gen:api`): a change of the spec
  breaks the build, not the POC.
- `src/form-contract.ts`: parse the live admin form, validate, post what a browser would post. Fail closed.
- `src/workflows.ts`: the wiki procedure (upload → layer → field → tasks → reload) and the step 8 checks.
- `src/server.ts`: the tools. Pattern from la_toolkit_mcp: dry run by default, `confirm`, `next` hints for long
  tasks instead of long loops, annotations (`readOnlyHint`, `destructiveHint`).
- `reference/3.1.0/`: the admin GSP views and the OpenAPI spec of 3.1.0, and the forms rendered from the GSPs with
  `scripts/render-gsp.mjs` (a tiny renderer for the subset those views use). Used for dry-run previews, for the
  fake spatial-service in tests, and to detect drift.

### The form contract (why it does not break the admin UI)

Adding and editing layers goes through `/manageLayers/*`, the admin web pages. They are not part of the
documented API, and the server does not enforce what the HTML form enforces: `maxlength`s (`requestedId` 15,
`scale` 20, names 150…), select options (`type`, `domain`, `licence_level`, and `sname`, which must be a column of
the uploaded DBF) and fields that become read-only once a layer exists (`name`, `type`, `domain`, environmental
units). Something the form cannot express could leave a layer the UI cannot show or edit.

Every write therefore reads the **live form** and sends exactly what a browser would send with it, the form's own
defaults included:

| Change in a new spatial-service version | Effect |
|---|---|
| field added, `maxlength`/options/defaults changed | picked up automatically (the contract is read live) |
| field renamed/removed, new required field | refused, naming the field; nothing is sent (fail closed) |
| validation only in JavaScript (none in 3.1.0) | not seen; the drift test against `reference/3.1.0` catches form changes |
| redirects replaced by JSON | the client reads both; the integration test would catch the rest |

Because it posts the same fields as the form, what it creates looks the same in the admin UI as a layer created
by hand; the integration test checks the admin pages render it. `spatial_form_contract` shows the live contract
and its drift against 3.1.0.

### Tool reference

| Tool | Endpoint(s) | Kind |
|---|---|---|
| `spatial_health` | `/openapi/openapi.json`, `/layers`, `/manageLayers/layers.json` | read |
| `spatial_list_layers`, `spatial_get_layer` | `/layers`, `/layers/search`, `/layer/{id}` | read |
| `spatial_list_fields`, `spatial_get_field`, `spatial_list_objects` | `/fields`, `/fields/search`, `/field/{id}`, `/objects/{fid}` | read |
| `spatial_search_gazetteer`, `spatial_intersect` | `/search`, `/intersect/{ids}/{lat}/{lng}` | read |
| `spatial_capabilities` | `/tasks/capabilities` | read |
| `inspect_layer_zip` | local | read |
| `spatial_upload`, `spatial_create_layer`, `spatial_create_field`, `spatial_add_layer` | `/manageLayers/upload`, `/manageLayers/layer/{id}`, `/manageLayers/field/{id}`, `/tasks/status/{id}`, `/intersect/reloadconfig` | write, dry run by default |
| `spatial_verify_layer` | `/layers`, `/fields`, `/objects`, `/object`, `/shapes/kml`, `/intersect`, GeoServer WMS, admin page | read |
| `spatial_update_layer`, `spatial_update_field` | `/manageLayers/layer|field/{id}` | write, dry run by default |
| `spatial_form_contract`, `spatial_layer_admin`, `spatial_list_uploads` | `/manageLayers/*` | read (admin) |
| `spatial_reload_intersect_config` | `/intersect/reloadconfig` | write, confirm |
| `spatial_delete` | `/manageLayers/deleteLayer|deleteUpload/{id}` | destructive, confirm |
| `spatial_list_tasks`, `spatial_task_status` | `/tasks/all`, `/tasks/status/{id}` | read |
| `spatial_run_task` | `/tasks/create` (JSON body) | write, dry run by default |
| `spatial_cancel_task`, `spatial_rerun_task` | `/tasks/cancel/{id}`, `/tasks/reRun/{id}` | write, confirm |
| `spatial_compare_remote`, `spatial_import_from_remote` | `/manageLayers/remote`, `importLayer`, `importField` | read / write |
| `spatial_create_area`, `spatial_delete_area` | `/shape/upload/wkt|geojson`, `DELETE /shape/upload/{pid}` | write |

Sources for the operations: the LA wiki [Adding Layers](https://github.com/AtlasOfLivingAustralia/documentation/wiki/Adding-Layers)
and [Configuring the Spatial Portal](https://github.com/AtlasOfLivingAustralia/documentation/wiki/Configuring-the-Spatial-Portal),
ALA support articles ([Tools](https://support.ala.org.au/support/solutions/articles/6000208466-tools),
[Import](https://support.ala.org.au/support/solutions/articles/6000208473-import),
[Spatial layers](https://support.ala.org.au/support/solutions/articles/6000262426-spatial-layers)), and the 3.1.0 code and spec.

### Configuration

| Variable | Meaning |
|---|---|
| `SPATIAL_URL` / `--spatial` | spatial-service base URL including `/ws` |
| `SPATIAL_GEOSERVER_URL` / `--geoserver` | GeoServer base (default `<host>/geoserver`) |
| `SPATIAL_USERNAME`, `SPATIAL_PASSWORD` | admin account: browser-like login (OIDC → CAS form → session cookie) for the admin pages (falls back to `SPATIAL_OIDC_USERNAME`/`_PASSWORD`) |
| `SPATIAL_TOKEN` | OIDC access token (honoured only by `@RequireApiKey` actions, e.g. `/tasks/create`) |
| `SPATIAL_OIDC_ISSUER` or `SPATIAL_OIDC_TOKEN_URL`, `SPATIAL_OIDC_CLIENT_ID`, `SPATIAL_OIDC_CLIENT_SECRET`, `SPATIAL_OIDC_USERNAME`, `SPATIAL_OIDC_PASSWORD`, `SPATIAL_OIDC_SCOPE` | password grant, token cached and renewed (discovery finds the token endpoint) |
| `SPATIAL_API_KEY` | serviceKey, only for `/tasks/create` and `/tasks/cancel` without a user |
| `SPATIAL_READONLY=1` / `--readonly` | refuse every write |
| `SPATIAL_ALLOWED_DIRS` | `:`-separated directories zips may be read from |
| `SPATIAL_POLL_WAIT_MS` | how long a write waits for its tasks (default 20000) |
| `PORT`, `HOST` | HTTP transport (default 127.0.0.1:3920) |

### Remote (HTTP) transport

```bash
docker build -t spatial-mcp . && docker run -p 3920:3920 -e SPATIAL_URL=https://spatial.l-a.site/ws spatial-mcp
```

`src/http.ts` serves Streamable HTTP at `/mcp` (stateless, JSON responses) and `/health`. Each request gets a fresh
MCP server bound to the caller's own `Authorization: Bearer <token>`, which is forwarded to spatial-service and never
stored; without a token only public tools work. **Limitation (finding 1):** spatial-service 3.1.0 admin pages ignore
bearer tokens, so over HTTP the layer administration tools answer 401 until spatial-service accepts JWTs there;
reads, tasks and areas work. The idea is to run it next to spatial-service behind the same proxy
(e.g. an optional service in la-docker-compose), so admins connect by URL and install nothing. Not done yet: OAuth
discovery for MCP clients (they need to obtain the token themselves).

## Findings about spatial-service 3.1.0

1. **Admin pages need a browser session.** In 2.x `LoginInterceptor` let a valid API key through `@RequireAdmin`.
   In 3.x it needs `authService.getUserId()` plus the admin role, and `authService` only sees the pac4j profile of
   the web session: a bearer JWT is turned into a profile only by ala-ws-security's `AlaSecurityInterceptor`, which
   runs only on `@RequireApiKey` actions (`/tasks/create`, `/tasks/cancel`). Verified on the LA demo: a valid admin
   token from the CAS password grant gets `401 user login required` on `/manageLayers/*`. So `src/web-session.ts`
   logs in like a browser (spatial → OIDC authorize → CAS login form → callback → `JSESSIONID`) and retries once
   when a request is refused. Consequence: the HTTP transport, which only has the caller's token, cannot use the
   admin pages.
2. **Layer administration has no API.** `/manageLayers/*` is not in the OpenAPI spec; it answers with 302
   redirects to HTML pages, and ids have to be read from the `Location` header or from `…/layer/<id>.json`.
3. **The form's limits are only in the HTML.** `maxlength`s, select options and read-only fields are not checked
   server side.
4. **The spec and the code disagree on `/tasks/create`**: the spec documents a query parameter `inputs`,
   `TasksController.create` reads `input` (query) or a JSON body `{name, input}`.
5. **FieldCreation tasks are keyed by field id**, so they are listed on the field page, not on the layer page.
6. `/manageLayers/layers` and `/manageLayers/uploads` have no JSON format (the actions return a model for the GSP
   only), so the lists are read from the HTML tables.
7. On the LA demo stack (Jenkins `spatial-mcp-tests` #2, 2026-09-24) creating a layer fails with
   `relation "layers_id_seq" does not exist`: the layers database lacks the sequence that
   `docker/postgres/init_layersdb.sql` creates and `ManageLayersService.createOrUpdateLayer` uses
   (`nextval('layers_id_seq')`). It fails the same way from the admin UI; it is a deployment bug, not an MCP one.
   Cause: that layersdb had been created by Hibernate before la-docker-compose's init-databases ran, and the
   "first run only" guard skips the schema when the database exists. Deployments created from ala-install's
   `layersdb.sql` (2015) have it.
   The same skipped load leaves out the search functions (`search_objects_by_geometry_intersect`, `searchobjects`,
   `search_objects_by_location`), the `updateNameSearch` trigger and some tables (`obj_names`,
   `points_of_interest`…), so `/intersect` answers 500 there once a restart makes the field visible (finding 9).
   la-docker-compose now checks for the upstream schema on every deploy and stops if it is missing, never
   dropping or repairing it by itself (living-atlases/la-docker-compose@d9587f3); lademo's layersdb was rebuilt
   from `layersdb.sql` on 2026-09-24. ala-install's `layers-db` role has the same first-run-only load, but runs
   before spatial-service, so it only breaks if spatial-service reached an empty layersdb first or the load failed.
8. **Task specs are not found when spatial-service runs as an executable war** (`java -jar app.war`, as the
   Docker image does). `TasksService.getAllSpec()` lists the classpath dir `/processes/` with `java.io.File`,
   which is empty inside a war: `/tasks/capabilities` is `{}` and `LayerCreation`, `FieldCreation` and every
   analysis fail ("failed to find spec for: LayerCreation", then an NPE in `TasksService.create`). ala-install's
   Tomcat runs the war exploded, so ALA is not affected. la-docker-compose now runs the war exploded
   (living-atlases/la-docker-compose@8d2f754); the proper fix is to load `classpath*:/processes/*.json` with
   Spring's `PathMatchingResourcePatternResolver`.
9. **A new field does not answer point intersects until spatial-service restarts.** `LayerService.getIntersectionFiles()`
   is `@Cacheable` and nothing evicts it, and `/intersect/reloadconfig` (`LayerIntersectService.reload()`) is an empty
   `//TODO` in 3.1.0. So `/intersect/<new field>/<lat>/<lng>` returns `[]` until a restart; objects, KML, search and
   WMS work at once. `spatial_verify_layer` reports it with that hint. Upstream fix: evict the cache in `reload()`.
10. **The Docker image has no GDAL** (`gdal.dir: /usr/bin/`, but no `ogrinfo`/`gdal_translate`). Shapefile layers
   still work (GDAL only adds a spatial index), but grid layers (BIL/GeoTIFF), StandardizeLayers, Classification and
   Envelope need it. ala-install installs `gdal-bin`.

What would make this safe by design, and could be proposed upstream:
- a small JSON admin API for layers/fields (create, update, delete) documented in the OpenAPI spec, with the same
  validation as the form done server side;
- let `@RequireAdmin` accept a bearer JWT with the admin role (run the JWT authenticator for it too), and/or
  admin by API key or a scoped service token (client credentials with an admin scope) again;
- fix the `inputs`/`input` mismatch in the spec;
- load the task specs from the classpath, not from the file system (finding 8);
- make `/intersect/reloadconfig` refresh the intersectable fields (finding 9).

### Why not a Grails plugin inside spatial-service?

An in-process MCP endpoint (`/ws/mcp`, Java MCP SDK, calling `ManageLayersService` directly) would reuse the
server's validation and auth. It was considered and not chosen for the POC: it needs a fork or an optional plugin
that ALA would have to accept, a custom WAR on the demo stack, and ties releases to spatial-service's. The HTTP
transport of this server gives users the same "nothing to install" experience without touching spatial-service.

## Tests

| Suite | Runs against | What it pins |
|---|---|---|
| `test/form-contract.test.ts` | reference forms (real 3.1.0 GSPs) | parsing, defaults, fail-closed rules, read-only fields, drift signature |
| `test/shapefile.test.ts` | generated shapefiles | SHP/SHX/DBF/PRJ presence, WGS84, encoding, GeoTIFF/BIL rules, DBF columns |
| `test/misc.test.ts` | — | task verdicts, redaction, config, the GSP renderer |
| `test/mcp-e2e.test.ts` | fake spatial-service (`test/helpers/fake-spatial.ts`) | the whole flow over MCP, what reaches the server, failures, drift, read-only, auth, HTTP transport |
| `test/integration/lademo.test.ts` | a real spatial-service | spec drift, public reads, anonymous refusal; as admin: add → verify → admin UI → edit → delete |

`test/helpers/shapefile-fixture.ts` writes a valid 3-polygon WGS84 shapefile (checked with `ogrinfo`).

### CI

- **GitHub Actions** (`.github/workflows/ci.yml`): unit tests on Node 20/22, build, `npm audit`, and the anonymous
  integration tests against spatial.l-a.site (nightly too, to catch drift of the public API).
- **Jenkins** (jenkins.gbif.es, job `spatial-mcp-tests`, `Jenkinsfile`, `jenkins/config.xml`): runs next to the LA
  demo stack deployed by `la-docker-compose-tests`, waits while that job runs (it wipes `/data`), reads the admin
  credentials from the lademo inventory without echoing them, and runs the admin integration test, which creates
  and deletes an `mcp_poc_*` layer.

## License

MPL-2.0. spatial-service and spatial-hub are MPL-1.1 (file headers, and `info.license` of the OpenAPI spec), which
allows use under later versions, so MPL-2.0 keeps this compatible and open to contributing parts upstream.
Dependencies are MIT. `reference/3.1.0/` contains files from spatial-service 3.1.0 under their MPL-1.1 notice
(`reference/3.1.0/NOTICE`).

## Not covered yet

Styles/SLD and GeoServer settings, distributions and checklists (expert distributions), environmental (grid) layers
end to end, `LayerCopy` between servers, user/role management, the authorization-code (browser) login flow for stdio.
