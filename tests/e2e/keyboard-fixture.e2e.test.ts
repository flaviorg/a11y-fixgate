// Keyboard traversal of the storefront in a real browser (KBD-01 to KBD-04, spec 5.15 tab order).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createPlaywrightRunner } from "../../src/browser/playwright-runner.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import type { AuditSnapshot } from "../../src/contracts/snapshot.ts";
import type { AuditRunner } from "../../src/domain/ports.ts";
import { analyzeKeyboard } from "../../src/domain/keyboard/analyze.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { FIXTURE_ROOT, SITES_DIR } from "../helpers/fixtures.ts";
import { serveCopy } from "../helpers/serve.ts";

const logger = createLogger({ component: "runner", level: "error", write: () => {} });
let runner: AuditRunner | null = null;
after(async () => {
  await runner?.close();
});
const runnerFor = (exe: string): AuditRunner => (runner ??= createPlaywrightRunner({ executablePath: exe, outDir: null, logger }));

let baseline: Promise<AuditSnapshot> | null = null;
function storefront(exe: string): Promise<AuditSnapshot> {
  baseline ??= (async () => {
    const served = await serveCopy(FIXTURE_ROOT);
    try {
      return await runnerFor(exe).audit(served.target(), DEFAULT_PROFILE);
    } finally {
      await served.close();
    }
  })();
  return baseline;
}
const drafts = (snap: AuditSnapshot) => analyzeKeyboard(snap.traversal, DEFAULT_PROFILE.keyboard);
const classOf = (snap: AuditSnapshot, selector: string): string => snap.nodes[selector]?.attrs.class ?? "";

test("[KBD-01] the walk follows the tab order a.skip, a.logo, a.promo, search, button.cart, email, step-down, step-up, #qty and stops with \"trap\" on #qty", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefront(exe);
  const { steps } = snap.traversal;
  assert.equal(snap.traversal.stoppedBecause, "trap");
  const first9 = steps.slice(0, 9).map((s) => {
    const d = snap.nodes[s.selector]!;
    return `${s.tag}${classOf(snap, s.selector) ? "." + classOf(snap, s.selector).split(" ").join(".") : ""}${s.id ? "#" + s.id : ""}${s.tag === "input" ? `[${d.attrs.type ?? "text"}]` : ""}`;
  });
  assert.deepEqual(first9, ["a.skip", "a.logo", "a.promo", "input[search]", "button.cart", "input[email]", "button.step.step-down", "button.step.step-up", "input#qty[text]"]);
  assert.deepEqual(steps.map((s) => s.index), steps.map((_s, i) => i));
  assert.equal(steps.length, 11, "9 distinct elements, then #qty twice more (3 identical steps)");
  assert.deepEqual(steps.slice(8).map((s) => s.selector), ["#qty", "#qty", "#qty"]);
  assert.ok(steps.every((s) => s.hostKind === "plain"));
  for (const s of steps) assert.ok(snap.nodes[s.selector], `descriptor for step ${s.selector}`);
  assert.ok(!steps.some((s) => (snap.nodes[s.selector]!.attrs.class ?? "").includes("newsletter")), "the footer's injected controls are never reached");
});

test("[KBD-02] the storefront gives exactly one keyboard-trap, on #qty", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefront(exe);
  const traps = drafts(snap).filter((d) => d.ruleId === "keyboard-trap");
  assert.equal(traps.length, 1);
  assert.equal(traps[0]!.nodeKey, "#qty");
  assert.equal(traps[0]!.message, "Focus stayed on #qty for 3 Tabs (possible trap)");
  assert.equal(snap.nodes["#qty"]!.tag, "input");
});

test("[KBD-03] the storefront gives exactly one unreachable-control, on div.btn", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefront(exe);
  const unreachable = drafts(snap).filter((d) => d.ruleId === "unreachable-control");
  assert.equal(unreachable.length, 1);
  const node = snap.nodes[unreachable[0]!.nodeKey];
  assert.ok(node, "the candidate has a descriptor");
  assert.deepEqual([node.tag, node.attrs.class, node.text], ["div", "btn", "Add to cart"]);
  assert.deepEqual(snap.traversal.interactiveCandidates.map((c) => [c.tag, c.reason, c.focusable, c.reached, c.hasFocusableDescendant]), [["div", "onclick", false, false, false]]);
});

test("[KBD-04] the storefront gives exactly one focus-obscured, on a.skip, fully covered", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefront(exe);
  const obscured = drafts(snap).filter((d) => d.ruleId === "focus-obscured");
  assert.equal(obscured.length, 1);
  assert.equal(snap.nodes[obscured[0]!.nodeKey]!.attrs.class, "skip");
  assert.match(obscured[0]!.message, /is fully \(5 of 5 points\) covered by .*header/);
  assert.equal(drafts(snap).length, 3, "exactly three keyboard drafts on the storefront");
});

test("[KBD-01] the walk starts from the document with nothing focused and never focuses or blurs from script", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const served = await serveCopy(join(SITES_DIR, "focus-log"));
  t.after(() => served.close());
  const snap = await runnerFor(exe).audit(served.target(), DEFAULT_PROFILE);
  // The page logs what was focused at load and counts focus and blur events; a script focus() or blur() would add events no Tab caused.
  assert.deepEqual(snap.traversal.steps.map((s) => s.selector), ["#one", "#two", "#log"]);
  assert.equal(snap.traversal.stoppedBecause, "body");
  assert.equal(snap.nodes["#log"]!.attrs["data-log"], "load:BODY");
  assert.equal(snap.nodes["#log"]!.attrs["data-focus-events"], "6", "3 focus and 3 blur events, one pair per Tab");
  assert.deepEqual(snap.traversal.interactiveCandidates.map((c) => [c.selector, c.reason, c.focusable, c.reached]), [["#log", "role-button", true, true]]);
});
