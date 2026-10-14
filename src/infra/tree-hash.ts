// treeSha256: the key of recordings (spec 5.3). Hash of every regular file under the served root.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../domain/errors.ts";
import { canonicalPath, isExcludedName, toPosix } from "./paths.ts";

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export const SRC_TOO_LARGE_MESSAGE = "Source root exceeds 2,000 files or 50 MB; narrow --src";

export type WalkOptions = { excludeAbs?: string[]; maxFiles?: number };

/**
 * Relative posix paths and absolute paths of the regular files under root, sorted by relative path.
 * Skips symlinks, excluded names (node_modules, .git) and excludeAbs (matched on real paths).
 * Throws SRC_TOO_LARGE above maxFiles.
 */
export function listRegularFiles(root: string, { excludeAbs = [], maxFiles = 2000 }: WalkOptions = {}): Array<{ rel: string; abs: string; size: number }> {
  const rootReal = realpathSync(root);
  const excluded = new Set(excludeAbs.map(canonicalPath));
  const found: Array<{ rel: string; abs: string; size: number }> = [];
  const visit = (dir: string, relDir: string): void => {
    for (const name of readdirSync(dir)) {
      if (isExcludedName(name)) continue;
      const abs = join(dir, name);
      if (excluded.has(abs)) continue;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) continue;
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      if (stat.isDirectory()) visit(abs, rel);
      else if (stat.isFile()) {
        found.push({ rel: toPosix(rel), abs, size: stat.size });
        if (found.length > maxFiles) throw new AppError("SRC_TOO_LARGE", SRC_TOO_LARGE_MESSAGE);
      }
    }
  };
  visit(rootReal, "");
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** sha256(sortedRelPosix.map(f => f + ":" + sha256(bytes)).join("\n")) over the regular files under root. */
export function treeSha256(root: string, options: WalkOptions = {}): string {
  const lines = listRegularFiles(root, options).map((f) => `${f.rel}:${sha256(readFileSync(f.abs))}`);
  return sha256(lines.join("\n"));
}
