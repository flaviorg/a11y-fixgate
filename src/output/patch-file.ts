// fixes.patch (spec 5.8, OUT-02, P-11): one unified diff per touched file, from what is on disk to the combined content.
import { createTwoFilesPatch } from "diff";
import { isAbsolute, join, relative } from "node:path";
import { toPosix } from "../infra/paths.ts";

/** What fixesPatchText needs from a run (an AuditRun has all three). */
export type PatchInput = {
  /** The page files as the baseline audit read them, source-root-relative. */
  baselineFiles: Record<string, string>;
  /** The combined content of every touched file. */
  combinedFiles: Record<string, string>;
  /** What --write put on disk (empty without a write); the patch then starts from that content. */
  writtenFiles: Record<string, string>;
};

/** The path of a source file as the repository sees it (posix); the source-root-relative name when it lies outside the repository. */
export function repoRelative(file: string, sourceRoot: string, repoRoot: string): { path: string; outside: boolean } {
  const rel = toPosix(relative(repoRoot, join(sourceRoot, file)));
  const outside = rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  return outside ? { path: file, outside: true } : { path: rel, outside: false };
}

/**
 * The patch text, or null when no file differs (P-11: no fixes.patch is written then). The names are
 * "a/<repoRel>" and "b/<repoRel>" so `git apply` works from the repository root. After --write the base is
 * the written content, so the patch holds only what was left unwritten and still applies to the files on disk.
 */
export function fixesPatchText(result: PatchInput, sourceRoot: string, repoRoot: string): string | null {
  const parts: string[] = [];
  for (const file of Object.keys(result.combinedFiles).sort()) {
    const combined = result.combinedFiles[file]!;
    const base = result.writtenFiles[file] ?? result.baselineFiles[file];
    if (base === undefined || base === combined) continue;
    const { path } = repoRelative(file, sourceRoot, repoRoot);
    parts.push(createTwoFilesPatch(`a/${path}`, `b/${path}`, base, combined, "", "", { context: 3 }));
  }
  return parts.length === 0 ? null : parts.join("");
}
