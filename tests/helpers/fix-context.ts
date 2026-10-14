// FixContext builders for fixer tests: one page file, the target element by tag and ordinal.
import assert from "node:assert/strict";
import type { Finding } from "../../src/contracts/finding.ts";
import type { FixPlan } from "../../src/contracts/fix.ts";
import { applyEdits, checkCandidate, toUnifiedDiff } from "../../src/domain/fix/bounded-patch.ts";
import { createIdAllocator } from "../../src/domain/fix/id-allocator.ts";
import type { FixContext } from "../../src/domain/fix/types.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { anchorOf, fingerprintOf } from "../../src/domain/verify/fingerprint.ts";
import { makeNode, makeSnapshot } from "./snapshots.ts";

export type ContextOptions = {
  ruleId: string;
  tag: string;
  ordinal?: number;
  data?: Record<string, unknown>;
  lang?: string | null;
  domIds?: string[];
  /** Ids reserved in this run before the strategy runs. */
  reserved?: string[];
  file?: string;
};

export function fixContextFor(html: string, opts: ContextOptions): FixContext {
  const file = opts.file ?? "index.html";
  const index = buildHtmlIndex({ [file]: html });
  const f = index.files[file]!;
  const positions = f.byTag[opts.tag] ?? [];
  const el = f.elements[positions[opts.ordinal ?? 0]!];
  assert.ok(el, `no <${opts.tag}> number ${opts.ordinal ?? 0} in the page`);
  const location = { ...el.location, method: "ordinal" as const };
  const node = makeNode({ tag: opts.tag, attrs: el.attrs, text: el.text.slice(0, 200), domTagIndex: opts.ordinal ?? 0, domTagCount: positions.length, selector: opts.tag });
  const finding: Finding = {
    id: `${opts.ruleId}-1`,
    source: "axe",
    ruleId: opts.ruleId,
    status: "violation",
    impact: "serious",
    wcag: [],
    level: "A",
    help: "",
    helpUrl: "",
    message: "",
    node,
    location,
    fingerprint: fingerprintOf(opts.ruleId, anchorOf(location, node)),
    data: opts.data ?? {},
  };
  const domIds = opts.domIds ?? [...f.ids].sort();
  const ids = createIdAllocator(f.ids, domIds);
  for (const id of opts.reserved ?? []) ids.reserve(id);
  return { finding, location, source: html, index, snapshot: makeSnapshot({ domIds }), config: { lang: opts.lang ?? null, allowNewIncomplete: false }, ids };
}

/** Applies a plan's edits to the context's page and asserts that the candidate passes the bounds gate (items 1 to 4). */
export function applyChecked(ctx: FixContext, plan: FixPlan): string {
  const file = ctx.location.file;
  const patched = applyEdits(ctx.source, plan.edits);
  const patch = toUnifiedDiff(file, ctx.source, patched);
  assert.deepEqual(checkCandidate({ file, original: ctx.source, patched, patch, edits: plan.edits }), { ok: true });
  return patched;
}
