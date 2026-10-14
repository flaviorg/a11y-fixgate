// Source mapping (spec 5.4, MAP-01 to MAP-05) and source-side context for LLM inputs (LLM-09). Pure.
import type { NodeDescriptor, SourceLocation, Unmapped } from "../../contracts/finding.ts";
import { signatureOf } from "./html-index.ts";
import type { HtmlIndex, IndexedElement, IndexedFile } from "./html-index.ts";

const DATA_SOURCE = /^(?<file>[^:]+):(?<line>\d+):(?<col>\d+)$/;
const TEXT_MAX = 200; // describeNode cuts node.text at 200 chars

function located(el: IndexedElement, method: SourceLocation["method"]): SourceLocation {
  return { ...el.location, method };
}

/** A file named by data-a11y-source must be a plain relative posix path that the index holds. */
function safeIndexedFile(index: HtmlIndex, file: string): IndexedFile | null {
  if (file.startsWith("/") || file.includes("\\") || /^[A-Za-z]:/.test(file)) return null;
  if (file.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return Object.hasOwn(index.files, file) ? index.files[file]! : null;
}

/**
 * Maps a DOM node to its source element, in the order of spec 5.4: dom-only, attribute, page file,
 * ordinal, signature. Deterministic and never guesses: zero or several candidates stay unmapped.
 */
export function mapNode(node: NodeDescriptor, index: HtmlIndex, pageFile: string | null): SourceLocation | Unmapped {
  if (node.tag === "unknown" || node.domTagIndex < 0) return { reason: "dom-only" };

  // 1. Attribute (opt-in).
  const ds = node.dataSource !== null ? DATA_SOURCE.exec(node.dataSource) : null;
  if (ds?.groups) {
    const file = safeIndexedFile(index, ds.groups["file"]!);
    const line = Number(ds.groups["line"]);
    const col = Number(ds.groups["col"]);
    const hit = file?.elements.find((e) => e.tag === node.tag && e.location.startLine === line && e.location.startCol === col);
    return hit ? located(hit, "attribute") : { reason: "attribute-mismatch" };
  }

  // 2. Page file.
  if (pageFile === null || !Object.hasOwn(index.files, pageFile)) return { reason: "no-page-file" };
  const file = index.files[pageFile]!;
  const same = (file.byTag[node.tag] ?? []).map((i) => file.elements[i]!);
  const signature = signatureOf(node.tag, node.attrs);

  // 3. Ordinal, confirmed by the signature.
  if (same.length === node.domTagCount) {
    const c = same[node.domTagIndex];
    if (c && signatureOf(c.tag, c.attrs) === signature) return located(c, "ordinal");
  }

  // 4. Signature, with the text as a tie-breaker only when the node has text.
  let candidates = same.filter((e) => signatureOf(e.tag, e.attrs) === signature);
  if (candidates.length > 1 && node.text !== "") candidates = candidates.filter((e) => e.text.slice(0, TEXT_MAX) === node.text);
  if (candidates.length === 1) return located(candidates[0]!, "signature");
  return { reason: candidates.length === 0 ? "no-candidate" : "ambiguous" };
}

function elementAt(index: HtmlIndex, location: SourceLocation): { file: IndexedFile; el: IndexedElement } | null {
  const file = Object.hasOwn(index.files, location.file) ? index.files[location.file]! : null;
  const el = file?.elements.find((e) => e.location.startOffset === location.startOffset) ?? null;
  return file && el ? { file, el } : null;
}

/**
 * The collapsed text of the mapped element's parent in the source, cut at maxChars (spec 5.4, LLM-09).
 * An image's own text is excluded; an <img> has no text content, so the parent text is already without it.
 */
export function surroundingTextOf(location: SourceLocation, index: HtmlIndex, maxChars: number): string {
  const found = elementAt(index, location);
  if (!found || found.el.parent === null) return "";
  return found.file.elements[found.el.parent]!.text.slice(0, maxChars);
}

/** The source <title> text, else the first <h1> with text, else "". */
export function pageTitleOf(index: HtmlIndex, pageFile: string): string {
  if (!Object.hasOwn(index.files, pageFile)) return "";
  const file = index.files[pageFile]!;
  for (const tag of ["title", "h1"]) {
    for (const i of file.byTag[tag] ?? []) {
      const text = file.elements[i]!.text;
      if (text !== "") return text;
    }
  }
  return "";
}
