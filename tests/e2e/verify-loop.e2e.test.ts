// The verification loop in a real Chromium on a copy of the storefront, --llm none, --lang en (plan Task 23).
// Needs a browser (tests/helpers/browser.ts).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AuditRun } from "../../src/app/run-audit.ts";
import { createLlmStrategyRunner } from "../../src/app/llm-strategies.ts";
import { createPlaywrightRunner } from "../../src/browser/playwright-runner.ts";
import { isUnmapped } from "../../src/contracts/finding.ts";
import type { Finding } from "../../src/contracts/finding.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { analyzeSnapshot } from "../../src/domain/findings.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { anchorOf, domKey } from "../../src/domain/verify/fingerprint.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createFakeProvider } from "../../src/llm/fake-provider.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { FIXTURE_ROOT, runAuditOnFixtureCopy } from "../helpers/fixtures.ts";
import { htmlFilesOf } from "../helpers/scripted-runner.ts";
import { serveCopy } from "../helpers/serve.ts";

let shared: Promise<AuditRun> | null = null;
/** One pipeline run shared by the tests of this file (about 7 audits). */
function storefrontRun(t: TestContext, exe: string): Promise<AuditRun> {
  shared ??= runAuditOnFixtureCopy(t, exe, { llm: null });
  return shared;
}
let sharedFake: Promise<AuditRun> | null = null;
/** The demo run: the strict fake with fixtures/llm/storefront.json (15 audits), shared by the promo tests. */
function storefrontFakeRun(t: TestContext, exe: string): Promise<AuditRun> {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, "..", "llm", "storefront.json"), "utf8"));
  const logger = createLogger({ component: "llm", level: "error", write: () => {} });
  sharedFake ??= runAuditOnFixtureCopy(t, exe, { llm: (root) => createLlmStrategyRunner({ provider: createFakeProvider({ fixture, strict: true }), sourceRoot: root, pagePath: "/", logger }) });
  return sharedFake;
}
after(() => {
  shared = null;
  sharedFake = null;
});

const emailOf = (r: AuditRun): Finding => r.findings.find((f) => f.ruleId === "label" && f.node.domTagIndex === 1)!;

test("[VER-03] label-associate on the email field is rejected with new-incomplete duplicate-id-aria and label-fresh-id is accepted with email-2", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const r = await storefrontRun(t, exe);
  const email = emailOf(r);
  assert.ok(email && !isUnmapped(email.location), "the signup email input maps to the source");
  const outs = r.outcomes.filter((o) => "candidate" in o && o.candidate.findingId === email.id);
  assert.equal(outs.length, 2);
  assert.equal(outs[0]!.status, "rejected");
  assert.ok("candidate" in outs[0]! && outs[0]!.candidate.plan.strategy === "label-associate");
  assert.ok(outs[0]!.status === "rejected" && outs[0]!.verdict.status === "rejected" && outs[0]!.verdict.reasons.includes("new-incomplete"));
  assert.ok(outs[0]!.status === "rejected" && outs[0]!.newFindings.some((n) => n.ruleId === "duplicate-id-aria"));
  assert.equal(outs[1]!.status, "accepted");
  assert.ok("candidate" in outs[1]! && outs[1]!.candidate.plan.strategy === "label-fresh-id");
  assert.match("candidate" in outs[1]! ? outs[1]!.candidate.patch : "", /id="email-2"/);
  assert.ok(outs[1]!.status === "accepted" && outs[1]!.verified === "verified");
  // The rest of the deterministic path of the inventory (spec 5.15 rows 1, 2 and 12) with --llm none.
  const accepted = r.outcomes.flatMap((o) => (o.status === "accepted" ? [[o.candidate.plan.strategy, o.verified]] : []));
  assert.deepEqual(accepted, [["title-from-h1", "verified"], ["html-lang", "verified"], ["contrast-inline", "verified-present-needs-review"], ["label-fresh-id", "verified"]]);
  assert.deepEqual(r.combined?.included.length, 4);
  assert.deepEqual(r.warnings, []);
});

test('[AUD-10] the screen reader view after the email fix exists for the watched DOM key input[1], contains "Email" and is not the injected input', async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const r = await storefrontRun(t, exe);
  assert.ok(r.combined);
  const before = r.baseline.ariaByNode["input[1]"];
  const afterView = r.combined!.snapshot.ariaByNode["input[1]"];
  assert.equal(typeof afterView, "string");
  assert.match(afterView!, /Email/);
  assert.notEqual(afterView, before);
  assert.doesNotMatch(before ?? "", /Email/);
  // The injected newsletter input (input[3]) is still unlabeled after the fixes.
  assert.doesNotMatch(r.combined!.snapshot.ariaByNode["input[3]"] ?? "", /Email/);
});

test("[VER-02] selector drift does not matter: the email finding's fingerprint is the same before and after, while its selector changed", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const r = await storefrontRun(t, exe);
  const email = emailOf(r);
  // An edit that leaves the signup input unlabeled but gives it an id: axe now names it "#signup-email" instead of
  // input[name="email"], while the source anchor (src:index.html#input[1]) and so the fingerprint stay the same.
  const original = readFileSync(join(FIXTURE_ROOT, "index.html"), "utf8");
  const edited = original.replace('<input type="email" name="email">', '<input type="email" name="email" id="signup-email">');
  assert.notEqual(edited, original);
  const served = await serveCopy(FIXTURE_ROOT, (dir) => writeFileSync(join(dir, "index.html"), edited));
  const runner = createPlaywrightRunner({ executablePath: exe, outDir: null, logger: createLogger({ component: "runner", level: "error", write: () => {} }) });
  try {
    const snapshot = await runner.audit(served.target("/", [domKey(email.node)]), DEFAULT_PROFILE);
    const afterFindings = analyzeSnapshot(snapshot, buildHtmlIndex(htmlFilesOf(served.root)), "index.html", DEFAULT_PROFILE);
    const after = afterFindings.find((f) => f.ruleId === "label" && f.node.domTagIndex === 1)!;
    assert.ok(after, "the signup email input is still unlabeled");
    assert.equal(email.node.selector, JSON.stringify(['input[name="email"]']));
    assert.equal(after.node.selector, JSON.stringify(["#signup-email"]));
    assert.equal(after.fingerprint, email.fingerprint);
    assert.equal(anchorOf(after.location, after.node), "src:index.html#input[1]");
  } finally {
    await runner.close();
    await served.close();
  }
});

const promoOf = (r: AuditRun): Finding => r.findings.find((f) => f.ruleId === "link-name" && f.node.attrs["class"] === "promo")!;

test('[VER-03] with a real browser, "Shop deals" on the promo link is rejected with new-violation containing label-content-name-mismatch and "Sale: shop deals" is accepted', async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const r = await storefrontFakeRun(t, exe);
  const promo = promoOf(r);
  assert.ok(promo && !isUnmapped(promo.location), "the promo link maps to the source");
  const outs = r.outcomes.filter((o) => "candidate" in o && o.candidate.findingId === promo.id);
  assert.deepEqual(outs.map((o) => o.status), ["rejected", "accepted"]);
  const [rejected, accepted] = outs;
  assert.ok(rejected!.status === "rejected" && rejected!.verdict.status === "rejected" && rejected!.verdict.reasons.includes("new-violation"));
  assert.ok(rejected!.status === "rejected" && rejected!.newFindings.some((n) => n.ruleId === "label-content-name-mismatch"));
  assert.match("candidate" in rejected! ? rejected!.candidate.patch : "", /aria-label="Shop deals"/);
  assert.ok(accepted!.status === "accepted" && accepted!.verified === "verified-present-needs-review");
  assert.match("candidate" in accepted! ? accepted!.candidate.patch : "", /aria-label="Sale: shop deals"/);
  // The whole demo path of the inventory (spec 5.15) in a real browser.
  const s = r.summary;
  assert.deepEqual([s.accepted, s.verified, s.verifiedNeedsReview, s.rejected, s.gateRejected, s.suggestOnly, s.unmapped, s.conflicts], [11, 3, 8, 2, 1, 6, 1, 0]);
  assert.deepEqual([r.limits.candidatesUsed, r.llm.calls], [13, 10]);
  assert.deepEqual(r.warnings, []);
});

test('[AUD-10] the promo link\'s screen reader view goes from "- link" to a line containing link "Sale: shop deals"', async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const r = await storefrontFakeRun(t, exe);
  const key = domKey(promoOf(r).node);
  assert.equal(key, "a[2]");
  const before = r.baseline.ariaByNode[key] ?? "";
  const afterView = r.combined?.snapshot.ariaByNode[key] ?? "";
  assert.match(before, /^- link(:|$)/m);
  assert.doesNotMatch(before, /link "/);
  assert.match(afterView, /link "Sale: shop deals"/);
});
