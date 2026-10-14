// Reads and writes of project files (spec 6.2 item 2): realpath containment, no symlinks at any
// path segment, size cap, magic-byte MIME. Every read of a --src file goes through here.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AppError } from "../domain/errors.ts";
import { isInsideRoot } from "./paths.ts";

export const DEFAULT_MAX_READ_BYTES = 2_097_152;

const unsafe = (rel: string, reason: string): AppError =>
  new AppError("UNSAFE_PATH", `Refused to read or write ${rel}: outside the source root or a symbolic link`, { reason });

type Resolved = { abs: string; stat: Stats | null };

/** Validates rel lexically, then walks it segment by segment with lstat. stat is null when the path does not exist. */
function resolveSafe(root: string, rel: string): Resolved {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/") || isAbsolute(rel)) {
    throw unsafe(String(rel), "lexical");
  }
  const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) throw unsafe(rel, "lexical");

  const rootReal = realpathSync(root);
  let current = rootReal;
  let stat: Stats | null = null;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return { abs: current, stat: null };
      throw error;
    }
    if (stat.isSymbolicLink()) throw unsafe(rel, "symlink");
  }
  // No segment is a symlink, so this holds by construction; the check is the second line of defense.
  if (!isInsideRoot(rootReal, realpathSync(current))) throw unsafe(rel, "outside-root");
  return { abs: current, stat };
}

function missing(rel: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file: ${rel}`), { code: "ENOENT" });
}

/** Reads a regular file under root. A missing file surfaces as ENOENT; anything unsafe or too large is UNSAFE_PATH. */
export function readInsideRoot(root: string, relPath: string, { maxBytes = DEFAULT_MAX_READ_BYTES }: { maxBytes?: number } = {}): Buffer {
  const { abs, stat } = resolveSafe(root, relPath);
  if (stat === null) throw missing(relPath);
  if (!stat.isFile()) throw unsafe(relPath, "not-a-file");
  if (stat.size > maxBytes) {
    throw new AppError("UNSAFE_PATH", `Refused to read or write ${relPath}: file is larger than ${maxBytes} bytes`, { reason: "too-large" });
  }
  return readFileSync(abs);
}

/** True only for an existing regular file that passes every check; never throws for unsafe or missing paths. */
export function existsInsideRoot(root: string, rel: string): boolean {
  try {
    const { stat } = resolveSafe(root, rel);
    return stat !== null && stat.isFile();
  } catch {
    return false;
  }
}

/** Replaces the content of an existing regular file under root (same checks as reading). */
export function writeInsideRoot(root: string, rel: string, content: string): void {
  const { abs, stat } = resolveSafe(root, rel);
  if (stat === null) throw missing(rel);
  if (!stat.isFile()) throw unsafe(rel, "not-a-file");
  writeFileSync(abs, content, "utf8");
}

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Detects the image type from magic bytes. SVG (text) and anything else is null. */
export function sniffImageMime(buf: Uint8Array): ImageMime | null {
  const startsWith = (bytes: number[], at = 0): boolean => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
  const ascii = (text: string, at = 0): boolean => startsWith([...text].map((c) => c.charCodeAt(0)), at);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  if (ascii("GIF87a") || ascii("GIF89a")) return "image/gif";
  return null;
}
