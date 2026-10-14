import test from "node:test";
import assert from "node:assert/strict";
import { judge } from "../../src/domain/verify/acceptance-gate.ts";
import type { FindingSet } from "../../src/domain/verify/acceptance-gate.ts";
import { fingerprintOf } from "../../src/domain/verify/fingerprint.ts";
import { analyzeSnapshot, findingSetOf } from "../../src/domain/findings.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import type { Fingerprint } from "../../src/contracts/finding.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { axeResult, makeNode, makeSnapshot } from "../helpers/snapshots.ts";

const fp = (r: string, a = "src:index.html#input[1]") => fingerprintOf(r, a);
const set = (v: Fingerprint[] = [], i: Fingerprint[] = [], k: Fingerprint[] = []): FindingSet => ({ violations: new Set(v), incomplete: new Set(i), keyboard: new Set(k) });
const T = fp("label");
const O = fp("image-alt", "src:index.html#img[0]");
const N = fp("duplicate-id-aria");
const K = fp("keyboard-trap", "src:index.html#input[2]");

function rejected(v: ReturnType<typeof judge>) {
  assert.equal(v.status, "rejected");
  if (v.status !== "rejected") throw new Error("unreachable");
  return v;
}

test("[VER-02] accepts only when the target is gone and nothing is new", () => {
  assert.deepEqual(judge(set([T, O]), set([O]), T), { status: "accepted", targetGone: true, warnings: [] });
  // Unchanged keyboard findings and unchanged incomplete items do not matter.
  assert.deepEqual(judge(set([T], [N], [K]), set([], [N], [K]), T), { status: "accepted", targetGone: true, warnings: [] });
});

test("[VER-03] a new incomplete item rejects with new-incomplete and lists it", () => {
  const v = rejected(judge(set([T]), set([], [N]), T));
  assert.deepEqual([v.reasons, v.newIncomplete, v.targetGone], [["new-incomplete"], [N], true]);
  assert.deepEqual(v.newViolations, []);
});

test("[VER-03] a new violation rejects with new-violation", () => {
  const mismatch = fp("label-content-name-mismatch", "src:index.html#a[2]");
  const v = rejected(judge(set([T]), set([mismatch]), T));
  assert.deepEqual([v.reasons, v.newViolations, v.newIncomplete, v.targetGone], [["new-violation"], [mismatch], [], true]);
});

test("[VER-03] the target moving to incomplete is target-still-present", () => {
  const v = rejected(judge(set([T, O]), set([O], [T]), T));
  assert.equal(v.targetGone, false);
  assert.equal(v.reasons[0], "target-still-present");
  // It is hidden, not fixed: the target is also the downgraded entry.
  assert.deepEqual(v.reasons, ["target-still-present", "violation-downgraded"]);
  assert.deepEqual(v.newIncomplete, [T]);
  // Still present as a violation.
  assert.deepEqual(rejected(judge(set([T]), set([T]), T)).reasons, ["target-still-present"]);
});

test("[VER-02] a non-target violation moved to incomplete is rejected as violation-downgraded, also with allowNewIncomplete", () => {
  for (const allowNewIncomplete of [false, true]) {
    const v = rejected(judge(set([T, O]), set([], [O]), T, { allowNewIncomplete }));
    assert.deepEqual([v.reasons, v.newIncomplete, v.targetGone], [["violation-downgraded"], [O], true], String(allowNewIncomplete));
  }
  // A downgraded entry and a brand-new one together: both reasons without the flag, only the downgrade with it.
  assert.deepEqual(rejected(judge(set([T, O]), set([], [O, N]), T)).reasons, ["new-incomplete", "violation-downgraded"]);
  assert.deepEqual(rejected(judge(set([T, O]), set([], [O, N]), T, { allowNewIncomplete: true })).reasons, ["violation-downgraded"]);
});

test("[VER-02] a brand-new incomplete item with allowNewIncomplete is accepted with a warning", () => {
  assert.deepEqual(judge(set([T]), set([], [N]), T, { allowNewIncomplete: true }), { status: "accepted", targetGone: true, warnings: [`new-incomplete:${N}`] });
});

test("[VER-03] a new keyboard fingerprint rejects with new-keyboard-finding", () => {
  const v = rejected(judge(set([T]), set([], [], [K]), T));
  assert.deepEqual([v.reasons, v.targetGone], [["new-keyboard-finding"], true]);
  // A keyboard finding that disappears is fine.
  assert.equal(judge(set([T], [], [K]), set(), T).status, "accepted");
});

test("[VER-03] reasons come in the fixed order", () => {
  const v = rejected(judge(set([T, O]), set([T, fp("x")], [O, N], [K]), T));
  assert.deepEqual(v.reasons, ["target-still-present", "new-violation", "new-incomplete", "violation-downgraded", "new-keyboard-finding"]);
});

test("[VER-02] a baseline violation of another node that disappears is a collateral-fix warning, not a rejection", () => {
  const other = fp("label", "src:index.html#input[0]");
  assert.deepEqual(judge(set([T, other, O]), set([O]), T), { status: "accepted", targetGone: true, warnings: [`collateral-fix:${other}`] });
  assert.deepEqual(judge(set([T, other]), set([], [N]), T, { allowNewIncomplete: true }), {
    status: "accepted",
    targetGone: true,
    warnings: [`collateral-fix:${other}`, `new-incomplete:${N}`],
  });
});

test("[VER-01] judge finds a target produced by fingerprintOf in a set built by findingSetOf", () => {
  const files = { "index.html": '<!doctype html><html><head></head><body><img src="a.png"><input name="q"></body></html>' };
  const index = buildHtmlIndex(files);
  const img = makeNode({ selector: '["img"]', tag: "img", attrs: { src: "a.png" } });
  const input = makeNode({ selector: '["input"]', tag: "input", attrs: { name: "q" } });
  const node = (t: string) => ({ target: [t], html: "<x>", any: [], all: [], none: [] });
  const baseline = makeSnapshot({
    axe: { violations: [axeResult({ id: "image-alt", nodes: [node("img")] }), axeResult({ id: "label", nodes: [node("input")] })], incomplete: [], passesCount: 0, inapplicableCount: 0, toolOptions: {} },
    nodes: { '["img"]': img, '["input"]': input },
  });
  // After the fix the input carries an aria-label, so its selector and attributes changed; the anchor did not.
  const after = makeSnapshot({
    axe: { violations: [axeResult({ id: "image-alt", nodes: [node("img")] })], incomplete: [], passesCount: 0, inapplicableCount: 0, toolOptions: {} },
    nodes: { '["img"]': img },
  });
  const target = fingerprintOf("label", "src:index.html#input[0]");
  const baseSet = findingSetOf(analyzeSnapshot(baseline, index, "index.html", DEFAULT_PROFILE));
  assert.equal(baseSet.violations.has(target), true);
  const afterSet = findingSetOf(analyzeSnapshot(after, index, "index.html", DEFAULT_PROFILE));
  assert.deepEqual(judge(baseSet, afterSet, target), { status: "accepted", targetGone: true, warnings: [] });
  assert.equal(rejected(judge(baseSet, baseSet, target)).targetGone, false);
});
