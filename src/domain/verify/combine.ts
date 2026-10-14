// Edit-level combine of accepted candidates (spec 4.4, 5.6 "Combine", VER-05; P-13). Pure.
import type { Edit, FixCandidate } from "../../contracts/fix.ts";
import { AppError } from "../errors.ts";
import { applyEdits, assertBounded, strictApply, toUnifiedDiff } from "../fix/bounded-patch.ts";
import { buildHtmlIndex } from "../map/html-index.ts";

export type CombineResult = {
  /** Combined content per touched file. */
  files: Record<string, string>;
  /** One unified diff per touched file, baseline to combined, a/ and b/ names relative to the source root. */
  diffs: Record<string, string>;
  /** findingIds of the candidates in the combined set, in input order. */
  included: string[];
  /** with: the earlier finding id, or "id:<id>" when a generated id already exists in the file or the DOM. */
  conflicts: Array<{ findingId: string; with: string; reason: "overlap" | "id-collision" }>;
};

const sameRange = (a: Edit["startTag"], b: Edit["startTag"]) => a.file === b.file && a.startOffset === b.startOffset && a.endOffset === b.endOffset;

/** Same file and: overlapping ranges, equal start offsets (two inserts at one offset) or the same start tag. */
function conflicts(a: Edit, b: Edit): boolean {
  if (a.range.file !== b.range.file) return false;
  const ra = a.range;
  const rb = b.range;
  return ra.startOffset === rb.startOffset || (ra.startOffset < rb.endOffset && rb.startOffset < ra.endOffset) || sameRange(a.startTag, b.startTag);
}

/**
 * Combines accepted candidates at the edit level, never by applying diffs one after another. `accepted`
 * arrives in the document order of the findings (the caller guarantees it); a later candidate that
 * overlaps an included one, or whose generated id is already used, is a conflict and is left out.
 * The combined result is re-checked; a failure there is a programming error (BOUNDED_PATCH).
 */
export function combineEdits(baseline: Record<string, string>, accepted: FixCandidate[], domIds: string[]): CombineResult {
  const result: CombineResult = { files: {}, diffs: {}, included: [], conflicts: [] };
  const included: FixCandidate[] = [];
  const generatedBy = new Map<string, string>(); // id -> findingId of the included candidate that generated it
  const domIdSet = new Set(domIds);
  const fileIds = new Map<string, Set<string>>();
  const idsOf = (file: string): Set<string> => {
    let ids = fileIds.get(file);
    if (!ids) {
      ids = new Set(buildHtmlIndex({ [file]: baseline[file] ?? "" }).files[file]!.ids);
      fileIds.set(file, ids);
    }
    return ids;
  };

  for (const c of accepted) {
    for (const e of c.plan.edits) {
      if (!Object.hasOwn(baseline, e.range.file)) throw new AppError("BOUNDED_PATCH", `an accepted edit names a file outside the baseline: ${e.range.file}`, { findingId: c.findingId });
    }
    // Step 2: overlap with an earlier included candidate.
    const overlapWith = included.find((d) => d.plan.edits.some((f) => c.plan.edits.some((e) => conflicts(e, f))));
    if (overlapWith) {
      result.conflicts.push({ findingId: c.findingId, with: overlapWith.findingId, reason: "overlap" });
      continue;
    }
    // Step 3: generated ids must be new in the file, the DOM and the included candidates.
    const files = [...new Set(c.plan.edits.map((e) => e.range.file))];
    let collision: string | null = null;
    for (const id of c.plan.generatedIds) {
      const earlier = generatedBy.get(id);
      if (earlier !== undefined) collision = earlier;
      else if (domIdSet.has(id) || files.some((f) => idsOf(f).has(id))) collision = `id:${id}`;
      if (collision !== null) break;
    }
    if (collision !== null) {
      result.conflicts.push({ findingId: c.findingId, with: collision, reason: "id-collision" });
      continue;
    }
    included.push(c);
    result.included.push(c.findingId);
    for (const id of c.plan.generatedIds) generatedBy.set(id, c.findingId);
  }

  // Step 4: one applyEdits and one diff per file, then the combined diff is checked like a candidate's.
  const byFile = new Map<string, Edit[]>();
  for (const c of included) for (const e of c.plan.edits) byFile.set(e.range.file, [...(byFile.get(e.range.file) ?? []), e]);
  for (const file of [...byFile.keys()].sort()) {
    const edits = byFile.get(file)!;
    const original = baseline[file]!;
    const combined = applyEdits(original, edits);
    const diff = toUnifiedDiff(file, original, combined);
    const bounded = assertBounded(original, combined, edits.map((e) => e.range));
    if (!bounded.ok || strictApply(original, diff) !== combined) {
      throw new AppError("BOUNDED_PATCH", `the combined diff for ${file} failed its own bounds check`, { file, reason: bounded.ok ? "strict-apply-mismatch" : bounded.reason });
    }
    result.files[file] = combined;
    result.diffs[file] = diff;
  }
  return result;
}
