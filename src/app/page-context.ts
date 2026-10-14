// LLM task inputs built from the source files only (spec 5.4 "Surrounding text", 6.1, 6.2 items 2 and 6;
// LLM-05, LLM-09, VER-08, RF-5). Nothing here reads the live DOM, so the fake's keys are the same in
// recorded and browser mode. Image bytes are read only through readInsideRoot and typed by magic bytes.
import { createHash } from "node:crypto";
import type { AltTextInput, ControlNameInput } from "../contracts/llm.ts";
import { AppError } from "../domain/errors.ts";
import type { FixContext } from "../domain/fix/types.ts";
import type { IndexedElement, IndexedFile } from "../domain/map/html-index.ts";
import { pageTitleOf, surroundingTextOf } from "../domain/map/source-map.ts";
import type { Logger } from "../domain/ports.ts";
import { DEFAULT_MAX_READ_BYTES, sniffImageMime } from "../infra/safe-read.ts";
import type { readInsideRoot } from "../infra/safe-read.ts";

export const SURROUNDING_MAX = 600;
export const SNIPPET_MAX = 400;
const TITLE_MAX = 200;
const SRC_MAX = 500;
const HREF_MAX = 500;
const ICON_HINTS_MAX = 10;
const ICON_HINT_MAX = 60;

/** A host no page can name by accident: resolution against it keeps only same-origin paths. */
const BASE_ORIGIN = "http://a11y-fixgate.invalid";

/**
 * The source-root-relative path of an image src, resolved like the browser does against the page URL:
 * same origin only, query and hash dropped, percent-escapes decoded, leading "/" stripped. Another
 * scheme or host (https:, data:, protocol-relative), or a path that names a directory, gives null.
 * A relative src cannot climb above the root: URL resolution stops at "/".
 */
export function resolveImagePath(src: string, pagePath: string): string | null {
  if (src.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(src, BASE_ORIGIN + pagePath);
  } catch {
    return null;
  }
  if (url.origin !== BASE_ORIGIN) return null;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) return null;
  return path;
}

type FileAndElement = { file: IndexedFile; el: IndexedElement; at: number };

function sourceElement(ctx: FixContext): FileAndElement | null {
  const file = Object.hasOwn(ctx.index.files, ctx.location.file) ? ctx.index.files[ctx.location.file]! : null;
  if (!file) return null;
  const at = file.elements.findIndex((e) => e.location.startOffset === ctx.location.startOffset);
  return at < 0 ? null : { file, el: file.elements[at]!, at };
}

function hasAncestor(found: FileAndElement, tags: string[]): boolean {
  for (let p = found.el.parent; p !== null; p = found.file.elements[p]!.parent) if (tags.includes(found.file.elements[p]!.tag)) return true;
  return false;
}

function isDescendant(file: IndexedFile, index: number, ancestor: number): boolean {
  for (let p = file.elements[index]!.parent; p !== null; p = file.elements[p]!.parent) if (p === ancestor) return true;
  return false;
}

export type ImageReadDeps = {
  sourceRoot: string;
  pagePath: string;
  read: typeof readInsideRoot;
  logger?: Logger;
};

/** The image part of an alt-text input, or null (spec 6.1: 2 MB, png/jpeg/webp/gif by magic bytes; svg and anything else null). */
function imageFor(src: string, deps: ImageReadDeps): AltTextInput["image"] {
  const rel = resolveImagePath(src, deps.pagePath);
  if (rel === null) return null;
  let bytes: Buffer;
  try {
    bytes = deps.read(deps.sourceRoot, rel, { maxBytes: DEFAULT_MAX_READ_BYTES });
  } catch (error) {
    if (error instanceof AppError) deps.logger?.warn("image_refused", { code: error.code, src: rel });
    return null;
  }
  const mime = sniffImageMime(bytes);
  if (mime === null) return null;
  return { mime, bytesBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/** The alt-text input of an image finding: src, parent text and page title from the source, bytes from disk. */
export function altTextInputFor(ctx: FixContext, deps: ImageReadDeps): AltTextInput {
  const found = sourceElement(ctx);
  const src = found?.el.attrs["src"] ?? "";
  return {
    pageTitle: pageTitleOf(ctx.index, ctx.location.file).slice(0, TITLE_MAX),
    src: src.slice(0, SRC_MAX),
    surroundingText: surroundingTextOf(ctx.location, ctx.index, SURROUNDING_MAX),
    insideControl: found !== null && hasAncestor(found, ["a", "button"]),
    image: imageFor(src, deps),
  };
}

/** The control-name input: the source start tag, href, class tokens of the element and its descendants, parent text and page title. */
export function controlNameInputFor(ctx: FixContext, role: ControlNameInput["role"]): ControlNameInput {
  const found = sourceElement(ctx);
  const hints: string[] = [];
  if (found) {
    const add = (el: IndexedElement) => {
      for (const token of (el.attrs["class"] ?? "").split(/\s+/)) {
        if (token !== "" && !hints.includes(token) && hints.length < ICON_HINTS_MAX) hints.push(token.slice(0, ICON_HINT_MAX));
      }
    };
    add(found.el);
    for (let i = found.at + 1; i < found.file.elements.length && isDescendant(found.file, i, found.at); i++) add(found.file.elements[i]!);
  }
  const href = found?.el.attrs["href"];
  return {
    role,
    html: ctx.source.slice(ctx.location.startTag.startOffset, ctx.location.startTag.endOffset).slice(0, SNIPPET_MAX),
    surroundingText: surroundingTextOf(ctx.location, ctx.index, SURROUNDING_MAX),
    href: href === undefined ? null : href.slice(0, HREF_MAX),
    placeholder: null,
    iconHints: hints,
    pageTitle: pageTitleOf(ctx.index, ctx.location.file).slice(0, TITLE_MAX),
  };
}

