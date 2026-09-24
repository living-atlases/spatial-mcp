import { unzipSync } from "fflate";

/**
 * Local checks on a layer zip before it is uploaded, following the LA wiki "Adding Layers" page and
 * what spatial-service's processUpload accepts (.shp, .hdr+.bil, .grd):
 * - shapefile: SHP, SHX, DBF and PRJ; DBF in ISO-8859-1; WGS84;
 * - grid: HDR, BIL and PRJ (GeoTIFF has to be converted with gdal_translate -of EHdr first).
 */
export interface DbfColumn {
  name: string;
  type: string;
  /** Distinct values among the sampled records. */
  distinct: number;
  samples: string[];
}

export interface ZipInspection {
  kind: "shapefile" | "grid" | "unknown";
  files: string[];
  ok: boolean;
  errors: string[];
  warnings: string[];
  crs?: { wgs84: boolean; name?: string };
  records?: number;
  columns?: DbfColumn[];
  /** Columns that look like a good "sname" (source name) for a contextual field. */
  suggestedSname?: string[];
}

const SAMPLE_RECORDS = 2000;

export function inspectLayerZip(zip: Uint8Array): ZipInspection {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (e) {
    return { kind: "unknown", files: [], ok: false, errors: [`not a valid zip: ${(e as Error).message}`], warnings: [] };
  }
  const files = Object.keys(entries).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/"));
  const byExt = (ext: string) => files.filter((n) => n.toLowerCase().endsWith(ext));
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: ZipInspection = { kind: "unknown", files, ok: false, errors, warnings };

  const shp = byExt(".shp");
  const hdr = byExt(".hdr");
  const grd = byExt(".grd");
  const tif = [...byExt(".tif"), ...byExt(".tiff")];

  if (shp.length) {
    out.kind = "shapefile";
    if (shp.length > 1) errors.push(`the zip holds ${shp.length} .shp files; upload one layer per zip`);
    const base = shp[0]!.slice(0, -4);
    for (const ext of [".shx", ".dbf", ".prj"]) {
      if (!files.some((n) => n.toLowerCase() === (base + ext).toLowerCase())) errors.push(`missing ${base}${ext} (a shapefile needs SHP, SHX, DBF and PRJ)`);
    }
    const dbf = pick(entries, base + ".dbf");
    const cpg = pick(entries, base + ".cpg");
    const encoding = cpg ? new TextDecoder().decode(cpg).trim() : undefined;
    if (encoding && !/^(iso-?8859-?1|latin-?1|1252|cp1252|windows-1252)$/i.test(encoding)) {
      warnings.push(`the DBF declares encoding "${encoding}" (.cpg); the wiki recommends ISO-8859-1. Non-ASCII names may show garbled (re-export from QGIS with ISO-8859-1).`);
    }
    if (dbf) {
      try {
        const parsed = readDbf(dbf, /utf-?8/i.test(encoding ?? "") ? "utf-8" : "latin1");
        out.records = parsed.records;
        out.columns = parsed.columns;
        out.suggestedSname = parsed.columns
          .filter((c) => c.type === "C" && c.distinct > 1)
          .sort((a, b) => b.distinct - a.distinct)
          .map((c) => c.name)
          .slice(0, 3);
        if (parsed.records === 0) errors.push("the DBF has no records");
      } catch (e) {
        errors.push(`cannot read the DBF: ${(e as Error).message}`);
      }
    }
    checkPrj(pick(entries, base + ".prj"));
  } else if (hdr.length || grd.length) {
    out.kind = "grid";
    if (hdr.length) {
      const base = hdr[0]!.slice(0, -4);
      if (!files.some((n) => n.toLowerCase() === (base + ".bil").toLowerCase())) errors.push(`missing ${base}.bil next to ${hdr[0]}`);
      const prj = pick(entries, base + ".prj");
      if (!prj) errors.push(`missing ${base}.prj (a BIL grid needs HDR, BIL and PRJ)`);
      checkPrj(prj);
    }
  } else if (tif.length) {
    errors.push(`GeoTIFF is not accepted by the upload; convert it first, e.g. gdal_translate -of EHdr -ot Float32 ${tif[0]} out.bil (and zip out.bil, out.hdr, out.prj)`);
  } else {
    errors.push("no .shp, .hdr/.bil or .grd found in the zip");
  }
  out.ok = errors.length === 0;
  return out;

  function checkPrj(prj: Uint8Array | undefined) {
    if (!prj) return;
    const wkt = new TextDecoder().decode(prj);
    const projected = /^\s*PROJCS\[/i.test(wkt);
    const wgs84 = !projected && /WGS[_ ]?(19)?84|EPSG[",:]*4326/i.test(wkt);
    const name = wkt.match(/^\s*\w+\["([^"]+)"/)?.[1];
    out.crs = { wgs84, name };
    if (!wgs84) warnings.push(`the layer is not in WGS84 (${name ?? "unknown CRS"}); the portal handles other projections badly. Reproject to EPSG:4326 first (e.g. QGIS "Export > Save as", or ogr2ogr -t_srs EPSG:4326).`);
  }
}

function pick(entries: Record<string, Uint8Array>, name: string): Uint8Array | undefined {
  const key = Object.keys(entries).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? entries[key] : undefined;
}

/** Minimal dBase III reader: header, field descriptors and a sample of records. */
export function readDbf(buf: Uint8Array, encoding: "latin1" | "utf-8" = "latin1"): { records: number; columns: DbfColumn[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 33) throw new Error("file too short");
  const records = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recordLen = dv.getUint16(10, true);
  const dec = new TextDecoder(encoding === "latin1" ? "latin1" : "utf-8");
  const fields: Array<{ name: string; type: string; len: number; offset: number }> = [];
  let offset = 1; // deletion flag
  for (let p = 32; p + 32 <= headerLen && buf[p] !== 0x0d; p += 32) {
    const rawName = buf.subarray(p, p + 11);
    const end = rawName.indexOf(0);
    const name = dec.decode(end >= 0 ? rawName.subarray(0, end) : rawName).trim();
    const type = String.fromCharCode(buf[p + 11]!);
    const len = buf[p + 16]!;
    fields.push({ name, type, len, offset });
    offset += len;
  }
  const seen = fields.map(() => new Set<string>());
  const n = Math.min(records, SAMPLE_RECORDS);
  for (let r = 0; r < n; r++) {
    const base = headerLen + r * recordLen;
    if (base + recordLen > buf.length) break;
    if (buf[base] === 0x2a) continue; // deleted
    fields.forEach((f, i) => seen[i]!.add(dec.decode(buf.subarray(base + f.offset, base + f.offset + f.len)).trim()));
  }
  return {
    records,
    columns: fields.map((f, i) => ({ name: f.name, type: f.type, distinct: seen[i]!.size, samples: [...seen[i]!].slice(0, 5) })),
  };
}
