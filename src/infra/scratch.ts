// Scratch copies of the source tree (spec 5.6 step 1, 6.2 item 2). Candidates are written and audited here.
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AppError } from "../domain/errors.ts";
import type { Scratch, ScratchFactory } from "../domain/ports.ts";
import { canonicalPath, isExcludedName, isInsideRoot } from "./paths.ts";
import { SRC_TOO_LARGE_MESSAGE, listRegularFiles } from "./tree-hash.ts";

export type ScratchLimits = { maxFiles?: number; maxBytes?: number };

function cleanRelative(rel: string): string[] {
  if (rel.length === 0 || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) throw new AppError("UNSAFE_PATH", `Refused to read or write ${rel}: outside the source root or a symbolic link`);
  const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) throw new AppError("UNSAFE_PATH", `Refused to read or write ${rel}: outside the source root or a symbolic link`);
  return segments;
}

export function createScratchFactory({ maxFiles = 2000, maxBytes = 50 * 1024 * 1024 }: ScratchLimits = {}): ScratchFactory {
  return {
    async create(sourceRoot: string, { excludeAbs = [] }: { excludeAbs?: string[] } = {}): Promise<Scratch> {
      const rootReal = realpathSync(sourceRoot);
      const excluded = new Set(excludeAbs.map(canonicalPath));

      // Count first, so an oversized tree is refused before anything is copied.
      const listed = listRegularFiles(rootReal, { excludeAbs, maxFiles });
      const total = listed.reduce((sum, f) => sum + f.size, 0);
      if (total > maxBytes) throw new AppError("SRC_TOO_LARGE", SRC_TOO_LARGE_MESSAGE);

      const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-scratch-")));
      try {
        cpSync(rootReal, root, {
          recursive: true,
          filter: (src) => {
            if (src === rootReal) return true;
            if (isExcludedName(basename(src)) || excluded.has(src)) return false;
            return !lstatSync(src).isSymbolicLink();
          },
        });
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
      }

      return {
        root,
        files(): Record<string, string> {
          const out: Record<string, string> = {};
          for (const f of listRegularFiles(root, { maxFiles: Number.MAX_SAFE_INTEGER })) {
            if (/\.html?$/i.test(f.rel)) out[f.rel] = readFileSync(f.abs, "utf8");
          }
          return out;
        },
        write(files: Record<string, string>): void {
          for (const [rel, content] of Object.entries(files)) {
            const abs = join(root, ...cleanRelative(rel));
            if (!isInsideRoot(root, abs)) throw new AppError("UNSAFE_PATH", `Refused to read or write ${rel}: outside the source root or a symbolic link`);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, content, "utf8");
          }
        },
        dispose(): void {
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
  };
}

export const scratchFactory: ScratchFactory = createScratchFactory();

