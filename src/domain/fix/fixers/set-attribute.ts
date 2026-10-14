// Attribute edits (spec 5.5): insert ` name="value"` before the start tag's closing ">" or "/>", or replace an
// existing attribute within its own range. Values are escaped; nothing else in the tag is touched. Pure.
import type { SourceLocation } from "../../../contracts/finding.ts";
import type { Edit } from "../../../contracts/fix.ts";
import { escapeAttr } from "../plan.ts";

type TagLocation = Pick<SourceLocation, "file" | "startTag" | "attrs">;

/**
 * The offset where a new attribute goes: before "/>" when the tag is self-closing (a "/" that belongs to an
 * unquoted value is not a self-closing slash), else before ">", then back over whitespace so the new
 * attribute follows the last one with exactly the one space it brings.
 */
function insertionOffset(location: TagLocation, sourceText: string): number {
  const { startOffset: start, endOffset: end } = location.startTag;
  let at = end - 1; // the ">"
  const lastAttrEnd = Math.max(start, ...Object.values(location.attrs).map((r) => r.endOffset));
  if (sourceText[at - 1] === "/" && at - 1 >= lastAttrEnd) at--;
  while (at - 1 > start && at - 1 >= lastAttrEnd && /\s/.test(sourceText[at - 1]!)) at--;
  return at;
}

export function attributeEdit(location: TagLocation, name: string, value: string, sourceText: string): Edit {
  const startTag = { file: location.file, ...location.startTag };
  const text = `${name}="${escapeAttr(value)}"`;
  const existing = Object.hasOwn(location.attrs, name) ? location.attrs[name]! : null;
  if (existing) return { range: { file: location.file, ...existing }, replacement: text, kind: "attribute", startTag };
  const at = insertionOffset(location, sourceText);
  return { range: { file: location.file, startOffset: at, endOffset: at }, replacement: ` ${text}`, kind: "attribute", startTag };
}
