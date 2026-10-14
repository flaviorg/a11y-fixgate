import test from "node:test";
import assert from "node:assert/strict";
import type { TraversalStep, TraversalTrace } from "../../src/contracts/snapshot.ts";
import { analyzeKeyboard } from "../../src/domain/keyboard/analyze.ts";

const OPTS = { trapRepeats: 3 };
const step = (index: number, selector: string, over: Partial<TraversalStep> = {}): TraversalStep => ({
  index, selector, tag: selector.split(/[.#\s>]/)[0] || "a", id: null, coveredPoints: 0, coveredBy: null, tabindex: null, hostKind: "plain", ...over,
});
const trace = (steps: TraversalStep[], stoppedBecause: TraversalTrace["stoppedBecause"], interactiveCandidates: TraversalTrace["interactiveCandidates"] = []): TraversalTrace => ({ steps, stoppedBecause, interactiveCandidates });
const candidate = (over: Partial<TraversalTrace["interactiveCandidates"][number]> = {}): TraversalTrace["interactiveCandidates"][number] => ({
  selector: "div.btn", tag: "div", reason: "onclick", focusable: false, reached: false, hasFocusableDescendant: false, ...over,
});

test("[KBD-02] three identical plain steps give keyboard-trap, status incomplete, WCAG 2.1.2", () => {
  const drafts = analyzeKeyboard(trace([step(0, "a.skip"), step(1, "#qty"), step(2, "#qty"), step(3, "#qty")], "trap"), OPTS);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0], {
    ruleId: "keyboard-trap", status: "incomplete", impact: "serious", wcag: ["2.1.2"], level: "A",
    message: "Focus stayed on #qty for 3 Tabs (possible trap)", nodeKey: "#qty", data: { repeats: 3, firstStep: 1 },
  });
});

test("[KBD-02] shadow-host, iframe and native-composite steps never give a trap", () => {
  for (const hostKind of ["shadow-host", "iframe", "native-composite"] as const) {
    const steps = [step(0, "x-widget", { hostKind }), step(1, "x-widget", { hostKind }), step(2, "x-widget", { hostKind })];
    assert.deepEqual(analyzeKeyboard(trace(steps, "trap"), OPTS), [], hostKind);
  }
  assert.deepEqual(analyzeKeyboard(trace([step(0, "#a"), step(1, "#a"), step(2, "#b")], "body"), OPTS), [], "two repeats are not a trap");
});

test("[KBD-03] an onclick or role=button candidate that is neither focusable nor reached, with no focusable descendant, gives unreachable-control as a violation, WCAG 2.1.1", () => {
  const drafts = analyzeKeyboard(trace([step(0, "a.skip")], "body", [candidate(), candidate({ selector: "span.fake", tag: "span", reason: "role-button" })]), OPTS);
  assert.deepEqual(drafts.map((d) => [d.ruleId, d.status, d.impact, d.wcag, d.level, d.nodeKey]), [
    ["unreachable-control", "violation", "serious", ["2.1.1"], "A", "div.btn"],
    ["unreachable-control", "violation", "serious", ["2.1.1"], "A", "span.fake"],
  ]);
  assert.equal(drafts[0]!.message, "div.btn has a click handler (onclick) but is not focusable and was not reached with Tab");
  assert.equal(drafts[1]!.message, "span.fake has role=button but is not focusable and was not reached with Tab");
  assert.deepEqual(drafts[0]!.data, { reason: "onclick" });
});

test("[KBD-03] a wrapper with a focusable descendant is not reported", () => {
  const candidates = [
    candidate({ hasFocusableDescendant: true }),
    candidate({ selector: "a.card", tag: "a", reason: "role-link", focusable: true }),
    candidate({ selector: "div.reached", reached: true }),
  ];
  assert.deepEqual(analyzeKeyboard(trace([], "body", candidates), OPTS), []);
});

test("[KBD-04] 5 of 5 covered points read \"fully\", 2 of 5 read \"partly (2 of 5)\", WCAG 2.4.11, status incomplete", () => {
  const steps = [
    step(0, "a.skip", { coveredPoints: 5, coveredBy: "body > header" }),
    step(1, "a.logo"),
    step(2, "#email", { coveredPoints: 2, coveredBy: "div.toast" }),
    step(3, "a.skip", { coveredPoints: 5, coveredBy: "body > header" }),
  ];
  const drafts = analyzeKeyboard(trace(steps, "cycle"), OPTS);
  assert.deepEqual(drafts.map((d) => [d.ruleId, d.status, d.impact, d.wcag, d.level, d.nodeKey]), [
    ["focus-obscured", "incomplete", "moderate", ["2.4.11"], "AA", "a.skip"],
    ["focus-obscured", "incomplete", "moderate", ["2.4.11"], "AA", "#email"],
  ]);
  assert.equal(drafts[0]!.message, "Focused element a.skip is fully (5 of 5 points) covered by body > header");
  assert.equal(drafts[1]!.message, "Focused element #email is partly (2 of 5) covered by div.toast");
  assert.deepEqual(drafts[1]!.data, { coveredPoints: 2, coveredBy: "div.toast", step: 2 });
});

test("[KBD-01] a trace stopped by \"max-tabs\" or \"cycle\" yields no trap draft", () => {
  const steps = [step(0, "#a"), step(1, "#a"), step(2, "#a")];
  for (const stop of ["max-tabs", "cycle", "body"] as const) assert.deepEqual(analyzeKeyboard(trace(steps, stop), OPTS), [], stop);
});

test("[KBD-01] drafts come in a stable order: traps, then obscured steps, then unreachable controls", () => {
  const steps = [step(0, "a.skip", { coveredPoints: 5, coveredBy: "header" }), step(1, "#qty"), step(2, "#qty"), step(3, "#qty")];
  const drafts = analyzeKeyboard(trace(steps, "trap", [candidate()]), OPTS);
  assert.deepEqual(drafts.map((d) => d.ruleId), ["keyboard-trap", "focus-obscured", "unreachable-control"]);
});
