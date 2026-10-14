// Plan building blocks shared by the fixers (spec 5.5). Pure.
import type { FixPlan, StrategyKind } from "../../contracts/fix.ts";
import type { IndexedElement, IndexedFile } from "../map/html-index.ts";
import type { FixContext } from "./types.ts";

/** Escapes an attribute value for a double-quoted attribute: &, ", < and >. */
export function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escapes element text: &, < and >. */
export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A plan with no edits, no review flag and no generated ids; fixers complete the rest. */
export function basePlan(strategy: string, kind: StrategyKind, summary: string): FixPlan {
  return { strategy, kind, edits: [], summary, needsHumanReview: false, reviewReason: null, generatedIds: [] };
}

/** The indexed page file of the target. */
export function fileOf(ctx: FixContext): IndexedFile | null {
  return Object.hasOwn(ctx.index.files, ctx.location.file) ? ctx.index.files[ctx.location.file]! : null;
}

/** The indexed element the finding is mapped to, and its position in the file's element list. */
export function targetOf(ctx: FixContext): { file: IndexedFile; el: IndexedElement; at: number } | null {
  const file = fileOf(ctx);
  if (!file) return null;
  const at = file.elements.findIndex((e) => e.location.startOffset === ctx.location.startOffset);
  return at < 0 ? null : { file, el: file.elements[at]!, at };
}

/** The elements of a tag in document order. */
export function elementsByTag(file: IndexedFile, tag: string): IndexedElement[] {
  return (file.byTag[tag] ?? []).map((i) => file.elements[i]!);
}
