// Bounded patches (spec 4.4, 5.6, FIX-08): materialization, unified diffs and the bounds gate. Pure.
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";
import type { Edit, SourceRange } from "../../contracts/fix.ts";
import { AppError } from "../errors.ts";

export type { Edit, SourceRange } from "../../contracts/fix.ts";

/** ok, or the first failed gate item as a stable reason code (logged; the outcome reason is patch-out-of-bounds). */
export type BoundsResult = { ok: true } | { ok: false; reason: BoundsReason };
export type BoundsReason =
  | "patch-file-count" // item 1: not exactly one file (or not a patch)
  | "patch-file-names" // item 1: names are not a/<file> and b/<file>
  | "strict-apply-mismatch" // item 2
  | "out-of-range" // item 3: original and patched differ outside the ranges
  | "edits-mismatch" // item 3: patched is not exactly the edits applied to original (or the edits are invalid)
  | "too-many-ranges" // item 4
  | "multiple-files" // item 4: an edit names another file
  | "attribute-markup" // item 4: <, > or a line break in an attribute replacement
  | "attribute-outside-start-tag" // item 4
  | "element-insert-not-title"; // item 4

const MAX_RANGES = 3;
const TITLE_INSERT = /^<title>[^<>\r\n]{1,120}<\/title>$/;
const OK: BoundsResult = { ok: true };
const fail = (reason: BoundsReason): BoundsResult => ({ ok: false, reason });

/**
 * Applies the edits to one file, splicing from the end so offsets stay valid. Edits must name one file,
 * lie inside the text, not overlap and have distinct start offsets; anything else is a programming error.
 */
export function applyEdits(original: string, edits: Edit[]): string {
  const files = new Set(edits.map((e) => e.range.file));
  if (files.size > 1) throw new AppError("BOUNDED_PATCH", "edits for more than one file were applied together", { files: [...files] });
  const sorted = [...edits].sort((a, b) => a.range.startOffset - b.range.startOffset);
  for (const [i, e] of sorted.entries()) {
    const { startOffset: s, endOffset: end } = e.range;
    if (s < 0 || end < s || end > original.length) throw new AppError("BOUNDED_PATCH", "an edit range lies outside the file", { range: e.range, length: original.length });
    const prev = sorted[i - 1];
    if (prev && (s === prev.range.startOffset || s < prev.range.endOffset)) {
      throw new AppError("BOUNDED_PATCH", "edits overlap or share a start offset", { a: prev.range, b: e.range });
    }
  }
  let out = original;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    out = out.slice(0, e.range.startOffset) + e.replacement + out.slice(e.range.endOffset);
  }
  return out;
}

/** The candidate diff: a/ and b/ names relative to the source root, 3 lines of context. */
export function toUnifiedDiff(file: string, original: string, patched: string): string {
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, original, patched, "", "", { context: 3 });
}

/** applyPatch with fuzzFactor 0; null when it does not apply (callers still compare the result to the expected text). */
export function strictApply(original: string, patch: string): string | null {
  try {
    const out = applyPatch(original, patch, { fuzzFactor: 0 });
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

function mergeRanges(ranges: SourceRange[]): Array<{ start: number; end: number }> {
  const sorted = ranges.map((r) => ({ start: r.startOffset, end: r.endOffset })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * Gate item 3: original and patched are identical outside the ranges (offsets in the original). The prefix
 * and the tail are anchored; each gap between ranges must appear in order in between. Matching every gap
 * at its leftmost position finds an alignment whenever one exists, so "ok" means: patched is original with
 * each range replaced by some text, and nothing else changed.
 */
export function assertBounded(original: string, patched: string, ranges: SourceRange[]): BoundsResult {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return original === patched ? OK : fail("out-of-range");
  const first = merged[0]!;
  const last = merged[merged.length - 1]!;
  if (first.start < 0 || last.end > original.length) return fail("out-of-range");
  if (original.slice(0, first.start) !== patched.slice(0, first.start)) return fail("out-of-range");
  const tail = original.slice(last.end);
  const tailStart = patched.length - tail.length;
  if (tailStart < first.start || patched.slice(tailStart) !== tail) return fail("out-of-range");
  let cursor = first.start;
  for (let i = 1; i < merged.length; i++) {
    const gap = original.slice(merged[i - 1]!.end, merged[i]!.start);
    const at = patched.indexOf(gap, cursor);
    if (at < 0) return fail("out-of-range");
    cursor = at + gap.length;
  }
  return cursor <= tailStart ? OK : fail("out-of-range");
}

/** Gate items 1 to 4 of spec 5.6, in order, for one candidate. */
export function checkCandidate(input: { file: string; original: string; patched: string; patch: string; edits: Edit[] }): BoundsResult {
  const { file, original, patched, patch, edits } = input;

  // 1. Exactly one file, named a/<file> and b/<file>.
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    return fail("patch-file-count");
  }
  if (parsed.length !== 1 || (parsed[0]!.oldFileName === undefined && parsed[0]!.hunks.length === 0)) return fail("patch-file-count");
  if (parsed[0]!.oldFileName !== `a/${file}` || parsed[0]!.newFileName !== `b/${file}`) return fail("patch-file-names");

  // 2. Strict apply reproduces the expected text.
  if (strictApply(original, patch) !== patched) return fail("strict-apply-mismatch");

  // 3. Nothing changed outside the ranges, and what changed is exactly the edits.
  const bounded = assertBounded(original, patched, edits.map((e) => e.range));
  if (!bounded.ok) return bounded;
  let expected: string;
  try {
    expected = applyEdits(original, edits);
  } catch {
    return fail("edits-mismatch");
  }
  if (expected !== patched) return fail("edits-mismatch");

  // 4. At most 3 ranges in this file; attribute edits stay inside their start tag; the only element is a <title>.
  if (edits.length > MAX_RANGES) return fail("too-many-ranges");
  if (edits.some((e) => e.range.file !== file || e.startTag.file !== file)) return fail("multiple-files");
  for (const e of edits) {
    if (e.kind === "attribute") {
      if (/[<>\r\n]/.test(e.replacement)) return fail("attribute-markup");
      if (e.range.startOffset <= e.startTag.startOffset || e.range.endOffset >= e.startTag.endOffset) return fail("attribute-outside-start-tag");
    } else if (!TITLE_INSERT.test(e.replacement)) {
      return fail("element-insert-not-title");
    }
  }
  return OK;
}
