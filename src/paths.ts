import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

/**
 * Local files the server may read and upload to spatial-service. An agent (or an injected instruction)
 * must not be able to upload arbitrary files such as ~/.ssh or ~/.config, so a path must: exist as a
 * regular file, be a .zip, contain no hidden (dot) directory or file, and, when SPATIAL_ALLOWED_DIRS is set
 * (":"-separated), lie inside one of those directories.
 */
export function assertLayerZip(path: string, allowedDirs: string[] = allowedFromEnv()): string {
  const abs = resolve(path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`file not found: ${path}`);
  }
  if (!statSync(real).isFile()) throw new Error(`not a regular file: ${path}`);
  for (const candidate of [abs, real]) {
    if (candidate.split(sep).some((seg) => seg.startsWith(".") && seg.length > 1)) {
      throw new Error(`refusing to use a hidden path (${path}): layer files must not live in dot-directories or be dotfiles`);
    }
  }
  if (extname(real).toLowerCase() !== ".zip") throw new Error(`a layer must be uploaded as a .zip (got "${extname(real) || "(none)"}")`);
  if (allowedDirs.length > 0) {
    const inside = allowedDirs.some((d) => {
      const dir = safeReal(d);
      return real === dir || real.startsWith(dir + sep);
    });
    if (!inside) throw new Error(`path is outside SPATIAL_ALLOWED_DIRS: ${path}`);
  }
  return real;
}

function safeReal(d: string): string {
  try {
    return realpathSync(resolve(d));
  } catch {
    return resolve(d);
  }
}

function allowedFromEnv(): string[] {
  return (process.env["SPATIAL_ALLOWED_DIRS"] ?? "").split(":").filter(Boolean);
}
