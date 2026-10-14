// Keyboard checks over a traversal trace (KBD-01 to KBD-04, P-16). Pure.
import type { FindingStatus, Impact } from "../../contracts/finding.ts";
import type { TraversalTrace } from "../../contracts/snapshot.ts";

export type KeyboardRuleId = "keyboard-trap" | "unreachable-control" | "focus-obscured";

export type KeyboardDraft = {
  ruleId: KeyboardRuleId;
  status: FindingStatus;
  impact: Impact;
  wcag: string[];
  level: "A" | "AA";
  message: string;
  /** Key into snapshot.nodes: the traversal selector or the interactive candidate's selector. */
  nodeKey: string;
  data: Record<string, unknown>;
};

/** Impact, status and criterion of each check (P-16; spec 5.1: unreachable-control is a violation, the others heuristics). */
export const KEYBOARD_RULES: Record<KeyboardRuleId, { status: FindingStatus; impact: Impact; wcag: string[]; level: "A" | "AA" }> = {
  "keyboard-trap": { status: "incomplete", impact: "serious", wcag: ["2.1.2"], level: "A" },
  "unreachable-control": { status: "violation", impact: "serious", wcag: ["2.1.1"], level: "A" },
  "focus-obscured": { status: "incomplete", impact: "moderate", wcag: ["2.4.11"], level: "AA" },
};

/** Help text and the WCAG 2.2 Understanding page of each check, for findings, SARIF rules and the report. */
export const KEYBOARD_HELP: Record<KeyboardRuleId, { help: string; helpUrl: string }> = {
  "keyboard-trap": { help: "Keyboard focus must be able to leave every component", helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html" },
  "unreachable-control": { help: "Interactive controls must be reachable with the keyboard", helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html" },
  "focus-obscured": { help: "A focused element must not be entirely hidden by other content", helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html" },
};

const SAMPLE_POINTS = 5;
const REASON_TEXT = { onclick: "has a click handler (onclick)", "role-button": "has role=button", "role-link": "has role=link" } as const;

function draft(ruleId: KeyboardRuleId, nodeKey: string, message: string, data: Record<string, unknown>): KeyboardDraft {
  const rule = KEYBOARD_RULES[ruleId];
  return { ruleId, status: rule.status, impact: rule.impact, wcag: [...rule.wcag], level: rule.level, message, nodeKey, data };
}

/** Drafts in a stable order: the trap, then obscured steps in tab order, then unreachable controls in document order. */
export function analyzeKeyboard(trace: TraversalTrace, opts: { trapRepeats: number }): KeyboardDraft[] {
  const drafts: KeyboardDraft[] = [];
  const { steps } = trace;

  // KBD-02: only a walk the runner stopped as a trap, ending in trapRepeats identical plain steps.
  if (trace.stoppedBecause === "trap" && steps.length >= opts.trapRepeats) {
    const last = steps[steps.length - 1]!;
    let first = steps.length - 1;
    while (first > 0 && steps[first - 1]!.selector === last.selector && steps[first - 1]!.hostKind === "plain") first--;
    const repeats = steps.length - first;
    if (last.hostKind === "plain" && repeats >= opts.trapRepeats) {
      drafts.push(draft("keyboard-trap", last.selector, `Focus stayed on ${last.selector} for ${repeats} Tabs (possible trap)`, { repeats, firstStep: steps[first]!.index }));
    }
  }

  // KBD-04: one draft per element, from its first covered step.
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.coveredPoints < 1 || seen.has(s.selector)) continue;
    seen.add(s.selector);
    const extent = s.coveredPoints >= SAMPLE_POINTS ? `fully (${SAMPLE_POINTS} of ${SAMPLE_POINTS} points)` : `partly (${s.coveredPoints} of ${SAMPLE_POINTS})`;
    drafts.push(draft("focus-obscured", s.selector, `Focused element ${s.selector} is ${extent} covered by ${s.coveredBy ?? "another element"}`, { coveredPoints: s.coveredPoints, coveredBy: s.coveredBy, step: s.index }));
  }

  // KBD-03
  for (const c of trace.interactiveCandidates) {
    if (c.focusable || c.reached || c.hasFocusableDescendant) continue;
    drafts.push(draft("unreachable-control", c.selector, `${c.selector} ${REASON_TEXT[c.reason]} but is not focusable and was not reached with Tab`, { reason: c.reason }));
  }
  return drafts;
}
