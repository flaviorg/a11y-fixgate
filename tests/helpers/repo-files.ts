// Scanners for tests/repo/conventions.unit.test.ts: file listing, import scanning, console scanning.
// They are text heuristics on purpose (spec 4.3): a regex over import lines and a text scan.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";

export const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

const SKIPPED_DIRS = new Set(["node_modules", ".git", "reports", "coverage"]);
const SKIPPED_PATHS = new Set(["tests/.scratch"]);

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Relative posix paths of the text files in the repository, skipping tooling and output directories and binary files. */
export function listRepoFiles(): string[] {
  const out: string[] = [];
  const visit = (relDir: string): void => {
    const abs = relDir === "" ? PROJECT_ROOT : resolve(PROJECT_ROOT, relDir);
    for (const name of readdirSync(abs).sort()) {
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      if (SKIPPED_DIRS.has(name) || SKIPPED_PATHS.has(rel)) continue;
      const stat = statSync(resolve(PROJECT_ROOT, rel));
      if (stat.isDirectory()) visit(rel);
      else if (stat.isFile() && !looksBinary(resolve(PROJECT_ROOT, rel))) out.push(rel);
    }
  };
  visit("");
  return out;
}

export function readRepoFile(rel: string): string {
  return readFileSync(resolve(PROJECT_ROOT, rel), "utf8");
}

/** Replaces comments with spaces, keeping line breaks so line numbers stay valid. `//` after a colon (URLs) is not a comment. */
export function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\"'`])(\/\/[^\n]*)/g, (_m, pre: string, c: string) => pre + blank(c));
}

const STATIC_IMPORT = /^[ \t]*(import|export)\s+(type\s+)?(?:[^;"'`]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Specifiers of static `import`/`export ... from` statements and `import("x")` calls.
 * `import type` and `export type` are skipped when includeTypeOnly is false.
 */
export function importSpecifiers(src: string, { includeTypeOnly = true }: { includeTypeOnly?: boolean } = {}): string[] {
  const code = stripComments(src);
  const found: Array<{ index: number; spec: string }> = [];
  for (const m of code.matchAll(STATIC_IMPORT)) {
    const isTypeOnly = m[2] !== undefined;
    if (isTypeOnly && !includeTypeOnly) continue;
    found.push({ index: m.index ?? 0, spec: m[3]! });
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT)) found.push({ index: m.index ?? 0, spec: m[1]! });
  return found.sort((a, b) => a.index - b.index).map((f) => f.spec);
}

/** Resolves a relative specifier against the importing file (repo-relative posix path). Bare and node: specifiers are returned as written. */
export function resolveImport(fromRel: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  return posix.normalize(posix.join(posix.dirname(fromRel), spec));
}

/** 1-based line numbers of console.log, console.info and console.debug calls (comments ignored). */
export function stdoutLines(src: string): number[] {
  const lines = stripComments(src).split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (/\bconsole\s*\.\s*(log|info|debug)\s*\(/.test(line)) hits.push(i + 1);
  });
  return hits;
}

/** 1-based line numbers where `pattern` matches in the code (comments ignored). */
export function codeLines(src: string, pattern: RegExp): number[] {
  const hits: number[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    if (pattern.test(line)) hits.push(i + 1);
  });
  return hits;
}
