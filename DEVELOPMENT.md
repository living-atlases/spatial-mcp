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

## Findings about spatial-service 3.1.0

1. **An API key no longer grants admin.** In 2.x `LoginInterceptor` let a valid API key through `@RequireAdmin`;
   in 3.x it needs `authService.getUserId()` plus the admin role, so automation needs a user token (OIDC). The
   serviceKey is only honoured by `@RequireApiKey` (`/tasks/create`, `/tasks/cancel`).
2. **Layer administration has no API.** `/manageLayers/*` is not in the OpenAPI spec; it answers with 302
   redirects to HTML pages, and ids have to be read from the `Location` header or from `…/layer/<id>.json`.
3. **The form's limits are only in the HTML.** `maxlength`s, select options and read-only fields are not checked
   server side.
4. **The spec and the code disagree on `/tasks/create`**: the spec documents a query parameter `inputs`,
   `TasksController.create` reads `input` (query) or a JSON body `{name, input}`.
5. **FieldCreation tasks are keyed by field id**, so they are listed on the field page, not on the layer page.
6. On the LA demo stack `/tasks/capabilities` returns `{}` anonymously (spatial.ala.org.au returns 16 public
   analyses), so `spatial_run_task` cannot pre-check inputs there; the server still validates them.

What would make this safe by design, and could be proposed upstream:
- a small JSON admin API for layers/fields (create, update, delete) documented in the OpenAPI spec, with the same
  validation as the form done server side;
- admin by API key or by a scoped service token (client credentials with an admin scope) again;
- fix the `inputs`/`input` mismatch in the spec.

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

## Not covered yet

Styles/SLD and GeoServer settings, distributions and checklists (expert distributions), environmental (grid) layers
end to end, `LayerCopy` between servers, user/role management, the authorization-code (browser) login flow for stdio.
