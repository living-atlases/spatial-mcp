import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import { inspectLayerZip } from "../src/shapefile.ts";
import { shapefileZip, UTM_PRJ } from "./helpers/shapefile-fixture.ts";

test("a good WGS84 shapefile passes, with DBF columns and sname suggestions", () => {
  const r = inspectLayerZip(shapefileZip());
  assert.equal(r.kind, "shapefile");
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.crs?.wgs84, true);
  assert.equal(r.records, 3);
  assert.deepEqual(r.columns?.map((c) => c.name), ["NAME", "CODE"]);
  assert.deepEqual(r.columns?.[0]?.samples, ["Norte", "Centro", "Sur"]);
  assert.equal(r.suggestedSname?.[0], "NAME");
  assert.deepEqual(r.warnings, []);
});

test("missing SHX/PRJ are errors (the wiki needs SHP, SHX, DBF and PRJ)", () => {
  const r = inspectLayerZip(shapefileZip("regions", undefined, { omit: [".shx"], prj: null }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("regions.shx")));
  assert.ok(r.errors.some((e) => e.includes("regions.prj")));
});

test("a projected CRS and a UTF-8 DBF are warned about", () => {
  const r = inspectLayerZip(shapefileZip("r", undefined, { prj: UTM_PRJ, cpg: "UTF-8" }));
  assert.equal(r.ok, true);
  assert.equal(r.crs?.wgs84, false);
  assert.ok(r.warnings.some((w) => w.includes("not in WGS84")));
  assert.ok(r.warnings.some((w) => w.includes("ISO-8859-1")));
});

test("GeoTIFF is refused with the gdal_translate hint; BIL grids need HDR+BIL+PRJ", () => {
  const tif = inspectLayerZip(zipSync({ "dem.tif": new Uint8Array([1, 2, 3]) }));
  assert.equal(tif.ok, false);
  assert.match(tif.errors[0]!, /gdal_translate -of EHdr/);
  const grid = inspectLayerZip(zipSync({ "bio1.hdr": new Uint8Array([1]), "bio1.bil": new Uint8Array([1]) }));
  assert.equal(grid.kind, "grid");
  assert.ok(grid.errors.some((e) => e.includes("bio1.prj")));
});

test("not a zip", () => {
  assert.equal(inspectLayerZip(new Uint8Array([1, 2, 3])).ok, false);
});
