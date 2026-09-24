# spatial-mcp

> **Experimental proof of concept.** This is not production software and it is not an ALA or Living Atlases
> product. It exists to find out whether routine [spatial-service](https://github.com/AtlasOfLivingAustralia/spatial-service)
> admin work can be done safely by an AI agent through [MCP](https://modelcontextprotocol.io). Try it on a
> test portal first (e.g. the LA demo stack), never directly on production.

An MCP server that lets an agent (Claude, or any MCP client) do the routine work of an ALA / Living Atlases
Spatial Portal: **adding layers** step by step as the LA wiki describes it, checking them, editing their metadata,
following background tasks, creating areas and running the portal's analyses.

It is the sibling of [ipt-mcp](https://github.com/vjrj/ipt-mcp) (GBIF IPT), with a difference: spatial-service
**has an API**, including an OpenAPI spec (`/ws/openapi/openapi.json`), so this server is a thin layer over real
endpoints instead of a form scraper. The one exception is layer administration, which only exists as admin web
pages, so for those the server submits the same forms a person would, guarded by the *form contract* (below).

## What it can do

| Tool | What for | Changes anything? |
|---|---|---|
| `spatial_health` | Which spatial-service, its version, whether admin access works, drift vs 3.1.0 | no |
| `spatial_list_layers`, `spatial_get_layer` | Layers (filter by text) | no |
| `spatial_list_fields`, `spatial_get_field`, `spatial_list_objects` | Fields (`cl…` contextual, `el…` environmental) and their objects | no |
| `spatial_search_gazetteer`, `spatial_intersect` | Find objects by name; values of fields at a point | no |
| `spatial_capabilities` | Analyses/processes the server can run and their inputs | no |
| `inspect_layer_zip` | Check a local zip before uploading (files, WGS84, DBF encoding, columns) | no (local) |
| `spatial_add_layer` | The whole wiki procedure: upload → layer → field → wait for tasks → reload intersect | **yes** (dry run by default) |
| `spatial_upload`, `spatial_create_layer`, `spatial_create_field` | The same, one step at a time | **yes** (dry run by default) |
| `spatial_verify_layer` | The wiki's step 8 checks (layers, fields, objects, KML, intersect, GeoServer, admin page) | no |
| `spatial_update_layer`, `spatial_update_field` | Edit metadata, classification, licence, flags | **yes** (dry run by default) |
| `spatial_form_contract` | What the admin form allows for a layer/field, and drift vs 3.1.0 | no |
| `spatial_layer_admin`, `spatial_list_uploads` | Admin view: a layer's fields and tasks; pending uploads | no |
| `spatial_reload_intersect_config` | Make new fields answer `/intersect` | **yes** (asks to confirm) |
| `spatial_delete` | Delete a layer, field or upload | **yes, destructive** (asks to confirm) |
| `spatial_list_tasks`, `spatial_task_status` | Background tasks and their log | no |
| `spatial_run_task` | Run an analysis (Area report, AOO/EOO, Points to grid…) or a maintenance process (Thumbnails, Tabulation…) | **yes** (dry run by default) |
| `spatial_cancel_task`, `spatial_rerun_task` | Cancel or re-run a task | **yes** (asks to confirm) |
| `spatial_compare_remote`, `spatial_import_from_remote` | Compare with / copy layer definitions from another spatial-service | import: **yes** |
| `spatial_create_area`, `spatial_delete_area` | User areas from WKT or GeoJSON (the portal's "Import > Areas") | **yes** |

The operations come from the public documentation: the Living Atlases wiki
[Adding Layers](https://github.com/AtlasOfLivingAustralia/documentation/wiki/Adding-Layers) and
[Configuring the Spatial Portal](https://github.com/AtlasOfLivingAustralia/documentation/wiki/Configuring-the-Spatial-Portal),
the ALA support articles on the Spatial Portal ([Tools](https://support.ala.org.au/support/solutions/articles/6000208466-tools),
[Import](https://support.ala.org.au/support/solutions/articles/6000208473-import),
[Spatial layers](https://support.ala.org.au/support/solutions/articles/6000262426-spatial-layers)), and the spatial-service 3.1.0 code and OpenAPI spec.

## How it avoids breaking the admin UI

Adding and editing layers goes through `/manageLayers/*`, the admin web pages of spatial-service. They are not
part of the documented API, and the server does not enforce what the HTML form enforces: `maxlength`s (a
`requestedId` of 15 characters, a `scale` of 20, names of 150…), the options of the selects (`type`, `domain`,
`licence_level`, and `sname`, which must be one of the uploaded DBF's columns) and the fields that become
read-only once a layer exists (`name`, `type`, `domain`, environmental units). Something the form cannot express
could leave a layer the UI cannot show or edit.

So every write reads the **live form** first and sends exactly what a browser would send with it, the form's own
defaults included, and refuses anything else:

- a field added, or a `maxlength`/option changed in a new spatial-service version → picked up automatically;
- a field renamed or removed → **refused** (fail closed), naming the field; nothing is sent;
- a read-only field → cannot be changed;
- drift is visible with `spatial_form_contract` and checked in CI against the 3.1.0 reference forms, which are
  rendered from the real GSP views (`reference/3.1.0/`, `scripts/render-gsp.mjs`).

Because the MCP posts the same fields as the form, whatever it creates looks the same in the admin UI as a layer
created by hand; the integration tests check that the admin pages render it.

## Setup

Needs Node.js 20+.

```bash
git clone https://github.com/vjrj/spatial-mcp && cd spatial-mcp && npm ci
```

### Local (stdio), e.g. Claude Code or Claude Desktop

```bash
claude mcp add spatial -e SPATIAL_OIDC_ISSUER=https://auth.l-a.site/cas/oidc -e SPATIAL_OIDC_CLIENT_ID=... \
  -e SPATIAL_OIDC_CLIENT_SECRET=... -e SPATIAL_OIDC_USERNAME=admin@example.org -e SPATIAL_OIDC_PASSWORD=... \
  -e SPATIAL_ALLOWED_DIRS=$HOME/layers -- npx tsx /path/to/spatial-mcp/src/stdio.ts --spatial https://spatial.l-a.site/ws
```

Without credentials only the public tools work. Admin tools in spatial-service 3.x need a **user with the admin
role**; an API key is not enough any more. Configure either:

| Variable | Meaning |
|---|---|
| `SPATIAL_URL` / `--spatial` | spatial-service base URL including `/ws` |
| `SPATIAL_TOKEN` | an OIDC access token of an admin user |
| `SPATIAL_OIDC_ISSUER` (or `SPATIAL_OIDC_TOKEN_URL`), `SPATIAL_OIDC_CLIENT_ID`, `SPATIAL_OIDC_CLIENT_SECRET`, `SPATIAL_OIDC_USERNAME`, `SPATIAL_OIDC_PASSWORD` | get and renew a token with the password grant |
| `SPATIAL_API_KEY` | serviceKey, only for `/tasks/create` and `/tasks/cancel` without a user |
| `SPATIAL_READONLY=1` | refuse every write (dry runs still work) |
| `SPATIAL_ALLOWED_DIRS` | `:`-separated directories layer zips may be read from |
| `SPATIAL_GEOSERVER_URL` | GeoServer base (default `<host>/geoserver`) |

### Remote (Streamable HTTP), nothing to install for users

```bash
docker build -t spatial-mcp . && docker run -p 3920:3920 -e SPATIAL_URL=https://spatial.l-a.site/ws spatial-mcp
```

Run it next to spatial-service, behind the same proxy (e.g. as an extra service in la-docker-compose), and
connect MCP clients to `https://<host>/mcp` with the user's own `Authorization: Bearer <token>`. The server holds
no credentials: each request is served with the caller's token, which is forwarded to spatial-service and never
stored.

## What to ask

- *"Check `~/layers/comarcas.zip` and tell me what's wrong with it."*
- *"Add `~/layers/comarcas.zip` as a contextual layer called `comarcas`, shown as 'Comarcas', under Area Management
  > Administrative, with the COMARCA column as the name of each area. Show me the preview first."*
- *"Is the layer ready? Check it like the wiki says, with a point in Zaragoza."*
- *"Move the layer `comarcas` to the Political > Regions classification and set the licence to CC BY."*
- *"What tasks failed this week? Show me the log of the last FieldCreation."*
- *"Which layers does spatial.ala.org.au have that we don't?"*
- *"Create an area from this GeoJSON and run an Area report on it."*
- *"Delete the test layer `mcp_poc_…` and its upload."*

## Security

- Writes are dry runs unless the call says `dryRun:false` **and** `confirm:true`; deletes and cancels need `confirm:true`.
  The server's instructions tell the agent to show the preview and ask first.
- `SPATIAL_READONLY=1` blocks every write.
- Tokens, passwords and keys are redacted from everything returned to the model.
- Only `.zip` files outside hidden directories (and inside `SPATIAL_ALLOWED_DIRS`, if set) can be uploaded.
- The HTTP transport stores nothing and has no credentials of its own.

## Tests

`npm test` runs the unit tests and an end-to-end MCP test against a fake spatial-service that renders the real
3.1.0 admin forms. `npm run test:integration` runs against a real spatial-service (`SPATIAL_TEST_URL`); with admin
credentials it adds a `mcp_poc_<timestamp>` layer, checks it and deletes it. CI: GitHub Actions (unit + anonymous
checks against the LA demo) and a Jenkins job next to the LA demo stack (admin tests). See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[MPL-2.0](LICENSE). spatial-service and spatial-hub are MPL-1.1, which allows use under later versions, so MPL-2.0
keeps this compatible with them and open to contributing parts upstream. The files in `reference/` come from
spatial-service 3.1.0 and keep their MPL-1.1 notice (see `reference/3.1.0/NOTICE`).
