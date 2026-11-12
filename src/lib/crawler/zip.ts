import { ZipArchive } from "archiver";
import fs from "node:fs";
import path from "node:path";
import { isSafeArchiveName } from "./security";

export interface ZipSource {
  dir: string;
  /** Folder name inside the archive ("" = archive root). */
  prefix: string;
}

async function* walk(dir: string, rel = ""): AsyncGenerator<{ abs: string; rel: string }> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    // Symlinks are never followed or archived.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(abs, r);
    else if (e.isFile()) yield { abs, rel: r };
  }
}

/**
 * Streams files into a ZIP one at a time (no whole-site buffering). Every entry
 * name is validated, so a crafted filename can never escape the extraction root.
 */
export async function createZip(zipPath: string, sources: ZipSource[]): Promise<{ bytes: number; entries: number }> {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  let entries = 0;
  const finished = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.on("warning", () => {});
  archive.pipe(output);
  for (const src of sources) {
    if (!fs.existsSync(src.dir)) continue;
    for await (const f of walk(src.dir)) {
      const name = src.prefix ? `${src.prefix}/${f.rel}` : f.rel;
      if (!isSafeArchiveName(name)) continue;
      archive.file(f.abs, { name });
      entries++;
    }
  }
  await archive.finalize();
  await finished;
  return { bytes: archive.pointer(), entries };
}
