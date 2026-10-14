// Acceptance gate (spec 5.6, VER-02, VER-03; P-12). Pure: the only place that decides a candidate.
import type { Fingerprint } from "../../contracts/finding.ts";
import type { FindingSet, RejectReason, Verdict } from "../../contracts/fix.ts";

export type { FindingSet, RejectReason, Verdict } from "../../contracts/fix.ts";

const minus = (a: Set<Fingerprint>, b: Set<Fingerprint>): Fingerprint[] => [...a].filter((x) => !b.has(x));

/**
 * Accepted iff the target is gone from violations and incomplete, no violation and no keyboard finding is
 * new, and no incomplete item is new (a brand-new one is tolerated with allowNewIncomplete and becomes a
 * warning). A baseline violation that moved to incomplete is hidden, not fixed: it is in newIncomplete and
 * rejects as violation-downgraded, flag or no flag. Baseline violations that disappeared besides the target
 * become collateral-fix warnings.
 */
export function judge(baseline: FindingSet, after: FindingSet, target: Fingerprint, opts: { allowNewIncomplete?: boolean } = {}): Verdict {
  const allowNewIncomplete = opts.allowNewIncomplete ?? false;
  const targetGone = !after.violations.has(target) && !after.incomplete.has(target);
  const newViolations = minus(after.violations, baseline.violations);
  const newIncomplete = minus(after.incomplete, baseline.incomplete);
  const downgraded = newIncomplete.filter((f) => baseline.violations.has(f));
  const brandNew = newIncomplete.filter((f) => !baseline.violations.has(f));
  const newKeyboard = minus(after.keyboard, baseline.keyboard);

  const reasons: RejectReason[] = [];
  if (!targetGone) reasons.push("target-still-present");
  if (newViolations.length > 0) reasons.push("new-violation");
  if (brandNew.length > 0 && !allowNewIncomplete) reasons.push("new-incomplete");
  if (downgraded.length > 0) reasons.push("violation-downgraded");
  if (newKeyboard.length > 0) reasons.push("new-keyboard-finding");

  if (targetGone && reasons.length === 0) {
    const collateral = [...baseline.violations].filter((f) => f !== target && !after.violations.has(f) && !after.incomplete.has(f));
    const warnings = [...collateral.map((f) => `collateral-fix:${f}`), ...(allowNewIncomplete ? brandNew.map((f) => `new-incomplete:${f}`) : [])];
    return { status: "accepted", targetGone: true, warnings };
  }
  return { status: "rejected", reasons, targetGone, newViolations, newIncomplete };
}
