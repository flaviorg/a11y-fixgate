// Value gates for LLM proposals (spec 6.2 item 5; LLM-02, LLM-03, LLM-04). The Zod shape first, then the
// value rules in the order of the spec. Reasons are stable strings used in tests, logs and the report. Pure.
import { altTextOutput, controlNameOutput } from "../../contracts/llm.ts";
import type { AltTextInput, AltTextOutput, ControlNameInput, ControlNameOutput } from "../../contracts/llm.ts";
import type { ValueGateReason } from "../../contracts/fix.ts";

export type { ValueGateReason };
export type GateResult<T> = { ok: true; output: T } | { ok: false; reason: ValueGateReason };

export const MAX_ALT = 125;
export const MAX_NAME = 80;
const REDUNDANT_PREFIXES = ["image of", "picture of", "photo of", "graphic of", "icon of"];
export const GENERIC_NAMES = new Set(["click here", "here", "link", "button", "read more", "more", "image", "icon", "submit"]);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string): boolean => collapse(a).toLowerCase() === collapse(b).toLowerCase();
const hasMarkup = (s: string): boolean => s.includes("<") || s.includes(">");
const hasUrl = (s: string): boolean => s.includes("://");
/** Case, "-", "_" and whitespace do not count when a value is compared with a file name. */
const normalizeName = (s: string): string => s.toLowerCase().replace(/[-_\s]+/g, "");

/** The file name stem of an image src: the last path segment without query, hash and extension. */
export function fileStemOf(src: string): string {
  const path = src.split(/[?#]/, 1)[0] ?? "";
  const last = path.split("/").pop() ?? "";
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // keep the raw segment
  }
  return decoded.replace(/\.[^.]*$/, "");
}

/**
 * alt-text proposal: schema, then (informative) 1 to 125 chars, no markup, no URL, no newline, not the file
 * name stem, no redundant prefix, not the adjacent text; (decorative) refused inside a control that has no
 * other name, that is when the adjacent text of the image is empty. The accepted alt is trimmed.
 */
export function altGate(raw: unknown, input: AltTextInput, adjacentText: string): GateResult<AltTextOutput> {
  const parsed = altTextOutput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema-invalid" };
  const out = parsed.data;
  if (out.kind === "decorative") {
    if (input.insideControl && collapse(adjacentText) === "") return { ok: false, reason: "decorative-inside-control" };
    return { ok: true, output: { ...out, alt: "" } };
  }
  const alt = out.alt.trim();
  if (alt === "") return { ok: false, reason: "alt-empty" };
  if (alt.length > MAX_ALT) return { ok: false, reason: "alt-too-long" };
  if (hasMarkup(alt)) return { ok: false, reason: "alt-has-markup" };
  if (hasUrl(alt)) return { ok: false, reason: "alt-has-url" };
  if (/[\r\n]/.test(out.alt)) return { ok: false, reason: "alt-has-newline" };
  const stem = normalizeName(fileStemOf(input.src));
  if (stem !== "" && normalizeName(alt.replace(IMAGE_EXT, "")) === stem) return { ok: false, reason: "alt-is-filename" };
  const lower = collapse(alt).toLowerCase();
  if (REDUNDANT_PREFIXES.some((p) => lower === p || lower.startsWith(p + " "))) return { ok: false, reason: "alt-redundant-prefix" };
  if (collapse(adjacentText) !== "" && sameText(alt, adjacentText)) return { ok: false, reason: "alt-equals-adjacent-text" };
  return { ok: true, output: { ...out, alt } };
}

/** control-name proposal: schema, then 1 to 80 chars, no markup, no URL, not the href, not a generic word. The accepted name is trimmed. */
export function nameGate(raw: unknown, input: ControlNameInput): GateResult<ControlNameOutput> {
  const parsed = controlNameOutput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema-invalid" };
  const name = parsed.data.name.trim();
  if (name === "") return { ok: false, reason: "name-empty" };
  if (name.length > MAX_NAME) return { ok: false, reason: "name-too-long" };
  if (hasMarkup(name)) return { ok: false, reason: "name-has-markup" };
  if (hasUrl(name)) return { ok: false, reason: "name-has-url" };
  if (input.href !== null && input.href.trim() !== "" && sameText(name, input.href)) return { ok: false, reason: "name-equals-href" };
  if (GENERIC_NAMES.has(collapse(name).toLowerCase())) return { ok: false, reason: "name-generic" };
  return { ok: true, output: { ...parsed.data, name } };
}
