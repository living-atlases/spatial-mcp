import { zipSync } from "fflate";

/**
 * Builds a small but valid polygon shapefile (SHP/SHX/DBF/PRJ/CPG) zipped, in WGS84: one square per
 * region. Used by the unit tests and by the integration test that really adds a layer.
 */
export interface Region {
  name: string;
  code: string;
  /** [minx, miny, maxx, maxy] */
  box: [number, number, number, number];
}

export const DEFAULT_REGIONS: Region[] = [
  { name: "Norte", code: "N", box: [-8, 42, -4, 44] },
  { name: "Centro", code: "C", box: [-5, 39, -2, 41.5] },
  { name: "Sur", code: "S", box: [-6, 36.5, -2, 38.5] },
];

export const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
export const UTM_PRJ = 'PROJCS["ETRS_1989_UTM_Zone_30N",GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["Meter",1.0]]';

export function shapefileZip(base = "regions", regions: Region[] = DEFAULT_REGIONS, opts: { prj?: string | null; cpg?: string; omit?: string[] } = {}): Uint8Array {
  const { shp, shx } = writeShp(regions.map((r) => r.box));
  const files: Record<string, Uint8Array> = {
    [`${base}.shp`]: shp,
    [`${base}.shx`]: shx,
    [`${base}.dbf`]: writeDbf([
      { name: "NAME", len: 30, values: regions.map((r) => r.name) },
      { name: "CODE", len: 5, values: regions.map((r) => r.code) },
    ]),
    [`${base}.cpg`]: new TextEncoder().encode(opts.cpg ?? "ISO-8859-1"),
  };
  if (opts.prj !== null) files[`${base}.prj`] = new TextEncoder().encode(opts.prj ?? WGS84_PRJ);
  for (const o of opts.omit ?? []) delete files[`${base}${o}`];
  return zipSync(files);
}

function writeShp(boxes: Array<[number, number, number, number]>) {
  const recs = boxes.map(([x0, y0, x1, y1]) => {
    // outer ring clockwise, closed
    const pts = [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];
    const content = new DataView(new ArrayBuffer(4 + 32 + 4 + 4 + 4 + pts.length * 16));
    let o = 0;
    content.setInt32(o, 5, true); o += 4;
    for (const v of [x0, y0, x1, y1]) { content.setFloat64(o, v, true); o += 8; }
    content.setInt32(o, 1, true); o += 4;
    content.setInt32(o, pts.length, true); o += 4;
    content.setInt32(o, 0, true); o += 4;
    for (const [x, y] of pts) { content.setFloat64(o, x!, true); content.setFloat64(o + 8, y!, true); o += 16; }
    return new Uint8Array(content.buffer);
  });
  const all = boxes.reduce((b, x) => [Math.min(b[0]!, x[0]), Math.min(b[1]!, x[1]), Math.max(b[2]!, x[2]), Math.max(b[3]!, x[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const shpLen = 100 + recs.reduce((s, r) => s + 8 + r.length, 0);
  const shxLen = 100 + recs.length * 8;
  const header = (len: number) => {
    const h = new DataView(new ArrayBuffer(100));
    h.setInt32(0, 9994, false);
    h.setInt32(24, len / 2, false);
    h.setInt32(28, 1000, true);
    h.setInt32(32, 5, true);
    all.forEach((v, i) => h.setFloat64(36 + i * 8, v, true));
    return new Uint8Array(h.buffer);
  };
  const shp = new Uint8Array(shpLen);
  const shx = new Uint8Array(shxLen);
  shp.set(header(shpLen));
  shx.set(header(shxLen));
  let off = 100;
  recs.forEach((r, i) => {
    const rh = new DataView(new ArrayBuffer(8));
    rh.setInt32(0, i + 1, false);
    rh.setInt32(4, r.length / 2, false);
    shp.set(new Uint8Array(rh.buffer), off);
    shp.set(r, off + 8);
    const xh = new DataView(new ArrayBuffer(8));
    xh.setInt32(0, off / 2, false);
    xh.setInt32(4, r.length / 2, false);
    shx.set(new Uint8Array(xh.buffer), 100 + i * 8);
    off += 8 + r.length;
  });
  return { shp, shx };
}

export function writeDbf(cols: Array<{ name: string; len: number; values: string[] }>): Uint8Array {
  const n = cols[0]?.values.length ?? 0;
  const headerLen = 32 + cols.length * 32 + 1;
  const recordLen = 1 + cols.reduce((s, c) => s + c.len, 0);
  const buf = new Uint8Array(headerLen + n * recordLen + 1);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x03;
  buf[1] = 126; buf[2] = 9; buf[3] = 24;
  dv.setUint32(4, n, true);
  dv.setUint16(8, headerLen, true);
  dv.setUint16(10, recordLen, true);
  const latin1 = (s: string) => Uint8Array.from([...s].map((c) => Math.min(c.charCodeAt(0), 255)));
  cols.forEach((c, i) => {
    const p = 32 + i * 32;
    buf.set(latin1(c.name.slice(0, 10)), p);
    buf[p + 11] = "C".charCodeAt(0);
    buf[p + 16] = c.len;
  });
  buf[headerLen - 1] = 0x0d;
  for (let r = 0; r < n; r++) {
    let p = headerLen + r * recordLen;
    buf[p++] = 0x20;
    for (const c of cols) {
      const v = latin1((c.values[r] ?? "").padEnd(c.len).slice(0, c.len));
      buf.set(v, p);
      p += c.len;
    }
  }
  buf[buf.length - 1] = 0x1a;
  return buf;
}
