import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/** True when targetReal is rootReal or lies below it. Both must be real paths. */
export function isInsideRoot(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

const EXCLUDED_NAMES = new Set(["node_modules", ".git"]);

/**
 * Directory or file names that are never hashed, copied or listed. The tool's own output is excluded by absolute
 * path (excludeAbs), never by name, so a site section called `reports/` is audited like any other directory.
 */
export function isExcludedName(name: string): boolean {
  return EXCLUDED_NAMES.has(name);
}

/**
 * Real path of p, also for a path that does not exist yet: the nearest existing ancestor is resolved
 * and the rest is appended. Lets an --out directory that is not created yet match through a symlinked root.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(canonicalPath(parent), basename(p));
  }
}
