# spatial-mcp

> **Experimental proof of concept.** This is not production software and it is not an ALA or Living Atlases
> product. Try it on a test portal first (for example the LA demo, spatial.l-a.site), never directly on production.

spatial-mcp lets you administer a Living Atlases **Spatial Portal** by talking to an AI assistant (Claude, or any
[MCP](https://modelcontextprotocol.io) client) instead of clicking through the spatial-service admin pages.
It is aimed at the people who run a portal: adding layers, checking them, fixing their metadata, watching the
background tasks.

You ask in plain language, for example *"add this shapefile as a layer of regions"*. The assistant checks
the file, shows you what it is going to do, and only does it after you say yes.

## What you can do with it

**Add a layer** (it follows the Living Atlases wiki page
[Adding Layers](https://github.com/AtlasOfLivingAustralia/documentation/wiki/Adding-Layers), step by step):
- check a zip before uploading it: that it has SHP, SHX, DBF and PRJ; that it is in WGS84; the DBF encoding;
  which column holds the name of each area;
- upload it, create the layer, create the field, wait for the background tasks and reload the intersect configuration;
- check the result the way the wiki's step 8 does: the layer and field are listed, the areas exist, KML and
  intersect work, GeoServer draws it, the admin page opens.

**Look after existing layers**
- list and search layers and fields; see their areas (objects);
- change a layer's display name, description, classification (the tree in the portal), licence, or enable/disable it;
- change a field's name, description, or whether it is searchable in the gazetteer;
- delete a layer, a field or an unused upload;
- compare your layers with another portal (e.g. spatial.ala.org.au) and copy a layer definition from it.

**Background tasks**
- see what is queued, running or failed, and the log of a task;
- cancel or re-run a task;
- run maintenance processes (thumbnails, tabulations…) and the portal's analyses (Area report, AOO/EOO,
  Points to grid…, see ALA's [Spatial Portal tools](https://support.ala.org.au/support/solutions/articles/6000208466-tools)).

**Areas**: create an area from WKT or GeoJSON, like the portal's *Import > Areas*, and delete it.

## Before you start

You need:
1. **Node.js 20 or later** on the computer where the assistant runs.
2. **An admin account** on the portal: the same username (e-mail) and password you use to log in to the
   spatial admin pages, with the admin role (e.g. `ROLE_ADMIN`). The assistant logs in with it the way your
   browser does. Without an account you can still use the read-only tools (list layers, fields, intersect…).

## Install

```bash
git clone https://github.com/vjrj/spatial-mcp
cd spatial-mcp
npm ci
```

Add it to Claude Code (one line; adapt the address and your account):

```bash
claude mcp add spatial -e SPATIAL_USERNAME=you@example.org -e SPATIAL_PASSWORD=your-password -e SPATIAL_ALLOWED_DIRS=/home/you/layers -- npx tsx /path/to/spatial-mcp/src/stdio.ts --spatial https://spatial.l-a.site/ws
```

For Claude Desktop, add the same to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spatial": {
      "command": "npx",
      "args": ["tsx", "/path/to/spatial-mcp/src/stdio.ts", "--spatial", "https://spatial.l-a.site/ws"],
      "env": {
        "SPATIAL_USERNAME": "you@example.org",
        "SPATIAL_PASSWORD": "your-password",
        "SPATIAL_ALLOWED_DIRS": "/home/you/layers"
      }
    }
  }
}
```

| Setting | What it is |
|---|---|
| `--spatial` (or `SPATIAL_URL`) | Your spatial-service address, ending in `/ws` |
| `SPATIAL_USERNAME`, `SPATIAL_PASSWORD` | Your admin account (see *Before you start*) |
| `SPATIAL_ALLOWED_DIRS` | Folders the assistant may upload zips from (recommended) |
| `SPATIAL_READONLY=1` | Look, don't touch: every change is refused (previews still work) |

Then ask *"Is the spatial MCP working?"*: it answers with the portal version, the number of layers and whether
your admin access works.

## Adding a layer, step by step

1. **Prepare the zip.** One layer per zip: a shapefile (SHP, SHX, DBF, PRJ) or a grid (HDR, BIL, PRJ), in WGS84,
   with the DBF in ISO-8859-1. A GeoTIFF has to be converted first (`gdal_translate -of EHdr …`).
2. **Ask the assistant to check it:** *"Check ~/layers/comarcas.zip"*. It tells you what is wrong, if anything,
   and which column looks like the name of each area.
3. **Ask for the layer:** *"Add ~/layers/comarcas.zip as a contextual layer called `comarcas`, shown as
   'Comarcas', under Area Management > Administrative, with the COMARCA column as the name of each area."*
   It shows you a **preview** of exactly what it will fill in on the admin form. Nothing has been changed yet.
4. **Say yes.** It uploads, creates the layer and the field, and waits for the tasks. Small layers finish in a
   few minutes; for big ones it tells you it is still working and checks back when you ask.
5. **Check it:** *"Check the new layer with a point in Zaragoza."* It runs the wiki's checks and tells you which
   ones pass.

You can also do it one step at a time (*"just upload it"*, *"now create the field"*), exactly like in the admin pages.

## More things to ask

- *"Which layers do we have under Area Management?"*
- *"Move the layer `comarcas` to Political > Regions and set the licence to CC BY."*
- *"Hide the layer `test_old`"* (disable it) or *"delete the layer `mcp_poc_…` and its upload."*
- *"What tasks failed this week? Show me the log of the last FieldCreation."*
- *"Re-run the thumbnails."*
- *"Which layers does spatial.ala.org.au have that we don't?"*
- *"Create an area from this GeoJSON and run an Area report on it."*

## Is it safe?

- **Nothing changes without your OK.** Every change is first shown as a preview; the assistant has to ask you
  and repeat the call with an explicit confirmation. Deleting and cancelling always ask.
- **It cannot do what the admin pages cannot do.** It fills in the same forms you would, with the same limits
  (lengths, allowed values, fields that cannot change once a layer exists). If a new spatial-service version
  changes a form in a way it does not understand, it stops instead of guessing.
- **It only uploads `.zip` files**, never from hidden folders, and only from `SPATIAL_ALLOWED_DIRS` if you set it.
- **Your password and tokens are never shown to the assistant**, not even in error messages.
- **`SPATIAL_READONLY=1`** turns it into a look-only tool.

It is still a proof of concept: use a test portal, and keep an eye on what it does.

## When something goes wrong

| Message | What to do |
|---|---|
| *login … was refused* | Wrong username or password: try them in the browser. |
| *needs a logged-in user with the admin role* (401/403) | Check `SPATIAL_USERNAME`/`SPATIAL_PASSWORD`, and that your account has the admin role in the portal. |
| *login did not reach spatial-service* | Your portal's login page is not the usual CAS one (e.g. a different identity provider). Please open an issue. |
| *not in WGS84* | Reproject the layer to EPSG:4326 (QGIS *Export > Save as*, or `ogr2ogr -t_srs EPSG:4326`). |
| *"sname" is needed* | Tell it which DBF column holds the name of each area (the check in step 2 suggests one). |
| *Refused by the form contract* | What you asked for doesn't fit the admin form (too long, not an allowed value, or it can't be changed). Change it, or do it by hand. |
| *LayerCreation/FieldCreation failed* | Ask for the task log. The usual causes are the projection, the encoding, or GeoServer. |
| *is not a field of the form* | The spatial-service version changed its admin form. Please open an issue. |

## Using it without installing anything (for portal operators)

The same server can run next to spatial-service, so admins connect to it by URL instead of installing it. For
now that mode only covers reads, tasks and areas: spatial-service 3.1.0 admin pages need a browser login, which
the remote mode does not have. See [DEVELOPMENT.md](DEVELOPMENT.md#remote-http-transport).

## More

- [DEVELOPMENT.md](DEVELOPMENT.md): how it works, design decisions, tests and CI, what spatial-service would need.
- License: [MPL-2.0](LICENSE) (compatible with spatial-service's MPL-1.1; see DEVELOPMENT.md).
- Sibling POC for the GBIF IPT: [ipt-mcp](https://github.com/vjrj/ipt-mcp).
