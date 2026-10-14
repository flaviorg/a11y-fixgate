// The fix loop (spec 5.6 "Outer loop", "Verification of one candidate", "Run limits"; P-3, P-15).
// Scripted runner, real scratch copies and real loopback servers, a test catalog defined here.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { TestContext } from "node:test";
import { runFixLoop } from "../../src/app/fix-loop.ts";
import { auditConfigSchema } from "../../src/contracts/config.ts";
import type { AuditConfig } from "../../src/contracts/config.ts";
import type { NodeDescriptor } from "../../src/contracts/finding.ts";
import type { Edit, FixOutcome, FixPlan } from "../../src/contracts/fix.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import type { AuditSnapshot } from "../../src/contracts/snapshot.ts";
import { analyzeSnapshot } from "../../src/domain/findings.ts";
import type { FixContext, LlmStrategy, LlmStrategyRunner, Strategy } from "../../src/domain/fix/types.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { combineEdits } from "../../src/domain/verify/combine.ts";
import { steppingClock } from "../../src/infra/clock.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createScratchFactory } from "../../src/infra/scratch.ts";
import { staticServerFactory } from "../../src/infra/static-server.ts";
import { treeSha256 } from "../../src/infra/tree-hash.ts";
import { scriptedRunner } from "../helpers/scripted-runner.ts";
import type { ScriptedCase } from "../helpers/scripted-runner.ts";
import { axeRule, makeNode, scriptedSnapshot } from "../helpers/snapshots.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";

const PAGE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Loop test</title></head>",
  "<body>",
  '<a href="/one" class="one">One</a>',
  '<a href="/two" class="two">Two</a>',
  '<a href="/three" class="three">Three</a>',
  '<div class="widget" onclick="go()">Go</div>',
  "</body>",
  "</html>",
  "",
].join("\n");

const LINKS = ["one", "two", "three"] as const;
const a = (i: 0 | 1 | 2): NodeDescriptor =>
  makeNode({ tag: "a", selector: `.${LINKS[i]}`, attrs: { href: `/${LINKS[i]}`, class: LINKS[i] }, text: LINKS[i][0]!.toUpperCase() + LINKS[i].slice(1), domTagIndex: i, domTagCount: 3 });
const widget = makeNode({ tag: "div", selector: "div.widget", attrs: { class: "widget", onclick: "go()" }, text: "Go", domTagIndex: 0, domTagCount: 1 });
const injected = makeNode({ tag: "input", selector: "#email", attrs: { id: "email", type: "email" }, domTagIndex: 0, domTagCount: 1 });

/** Baseline: rule-x on the given links. */
const linksSnapshot = (indexes: Array<0 | 1 | 2>, extra: Partial<Parameters<typeof scriptedSnapshot>[0]> = {}): AuditSnapshot =>
  scriptedSnapshot({ violations: indexes.length ? [axeRule("rule-x", indexes.map((i) => ({ node: a(i) })))] : [], ...extra });

const includes = (text: string) => (files: Record<string, string>) => files["index.html"]!.includes(text);

function plan(strategy: string, edits: Edit[], extra: Partial<FixPlan> = {}): FixPlan {
  return { strategy, kind: "deterministic", edits, summary: `${strategy} summary`, needsHumanReview: false, reviewReason: null, generatedIds: [], ...extra };
}

/** Inserts ` <attr>="1"` right before the ">" of the target's start tag. */
function insertAttr(ctx: FixContext, attr: string, value = "1"): Edit {
  const at = ctx.location.startTag.endOffset - 1;
  return { range: { file: ctx.location.file, startOffset: at, endOffset: at }, replacement: ` ${attr}="${value}"`, kind: "attribute", startTag: { file: ctx.location.file, ...ctx.location.startTag } };
}

const attrStrategy = (name: string, attr: string, calls?: { n: number }): Strategy => ({
  name,
  kind: "deterministic",
  run: (ctx) => {
    if (calls) calls.n++;
    return { type: "plan", plan: plan(name, [insertAttr(ctx, attr)]) };
  },
});

const llmStrategy: LlmStrategy = {
  name: "aria-label-llm",
  kind: "llm",
  task: "control-name",
  role: "link",
  toResult: (ctx, output) => ({
    type: "plan",
    plan: plan("aria-label-llm", [insertAttr(ctx, "aria-label", (output as { name: string }).name)], { kind: "llm", needsHumanReview: true, reviewReason: "llm-text" }),
  }),
};

type Setup = {
  baseline: AuditSnapshot;
  cases: ScriptedCase[];
  /** Omitted: the real catalog. */
  catalog?: Record<string, Strategy[]>;
  page?: string;
  config?: Partial<AuditConfig>;
  llm?: LlmStrategyRunner | null;
  onAudit?: () => void;
  clock?: ReturnType<typeof steppingClock>;
};

async function run(t: TestContext, s: Setup) {
  const root = tmpDir(t, "a11y-loop-");
  const page = s.page ?? PAGE;
  writeTree(root, { "index.html": page });
  const config = auditConfigSchema.parse({ sourceRoot: root, lang: "en", browser: { executablePath: null, source: "recorded" }, llm: { provider: "none" }, ...s.config });
  const files = { "index.html": page };
  const index = buildHtmlIndex(files);
  const findings = analyzeSnapshot(s.baseline, index, "index.html", DEFAULT_PROFILE);
  const runner = scriptedRunner(s.cases, { onAudit: s.onAudit });
  const lines: Array<Record<string, unknown>> = [];
  const clock = s.clock ?? steppingClock("2026-10-14T12:00:00.000Z");
  const logger = createLogger({ component: "loop", level: "debug", clock, write: (line) => lines.push(JSON.parse(line)) });
  const scratchRoots: string[] = [];
  const base = createScratchFactory();
  const scratch = {
    async create(src: string, opts?: { excludeAbs?: string[] }) {
      const s2 = await base.create(src, opts);
      scratchRoots.push(s2.root);
      return s2;
    },
  };
  const treeBefore = treeSha256(root);
  const result = await runFixLoop(
    { config, baseline: s.baseline, findings, baselineFiles: files, index, pageFile: "index.html", profile: DEFAULT_PROFILE, deadlineAt: clock.now().getTime() + config.deadlineMs, excludeAbs: [] },
    { runner, servers: staticServerFactory, scratch, clock, logger, llm: s.llm ?? null, ...(s.catalog ? { catalog: s.catalog } : {}) },
  );
  return { result, findings, runner, lines, root, treeBefore, scratchRoots };
}

const findingIdOf = (o: FixOutcome): string => ("candidate" in o ? o.candidate.findingId : o.findingId);
const statuses = (outcomes: FixOutcome[]) => outcomes.map((o) => `${findingIdOf(o)}:${o.status}${"reason" in o ? `:${o.reason}` : ""}`);

test("[FIX-01] strategies run in catalog order and the first accepted candidate ends the finding", async (t) => {
  const c = { n: 0 };
  const { result, runner } = await run(t, {
    baseline: linksSnapshot([0]),
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a"), attrStrategy("strategy-b", "data-b"), attrStrategy("strategy-c", "data-c", c)] },
    cases: [
      { when: includes('data-a="1"'), snapshot: scriptedSnapshot({ violations: [axeRule("new-rule", [{ node: a(1) }])] }) },
      { when: includes('data-b="1"'), snapshot: linksSnapshot([]) },
    ],
  });
  assert.deepEqual(result.outcomes.map((o) => [o.status, "candidate" in o ? o.candidate.plan.strategy : null]), [["rejected", "strategy-a"], ["accepted", "strategy-b"]]);
  assert.equal(c.n, 0);
  assert.equal(runner.audits(), 2);
  assert.deepEqual(result.accepted.map((x) => x.plan.strategy), ["strategy-b"]);
  const ok = result.outcomes[1]!;
  assert.ok(ok.status === "accepted" && ok.verified === "verified" && ok.verdict.status === "accepted");
  assert.match(ok.status === "accepted" ? ok.afterSnapshotSha : "", /^[0-9a-f]{64}$/);
});

test("[VER-03] a rejected candidate is followed by the next strategy and its outcome lists newFindings with ruleId and anchor", async (t) => {
  const { result, lines } = await run(t, {
    baseline: linksSnapshot([0]),
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a"), attrStrategy("strategy-b", "data-b")] },
    cases: [
      { when: includes('data-a="1"'), snapshot: scriptedSnapshot({ violations: [axeRule("new-rule", [{ node: a(1) }])] }) },
      { when: includes('data-b="1"'), snapshot: linksSnapshot([]) },
    ],
  });
  const rejected = result.outcomes[0]!;
  assert.equal(rejected.status, "rejected");
  if (rejected.status !== "rejected") return;
  assert.ok(rejected.verdict.status === "rejected");
  assert.deepEqual(rejected.verdict.status === "rejected" ? rejected.verdict.reasons : [], ["new-violation"]);
  assert.deepEqual(rejected.newFindings.map((n) => [n.ruleId, n.anchor]), [["new-rule", "src:index.html#a[1]"]]);
  assert.match(rejected.newFindings[0]!.fingerprint, /^[0-9a-f]{16}$/);
  const verdicts = lines.filter((l) => l["event"] === "candidate_verdict");
  assert.deepEqual(verdicts.map((l) => [l["findingId"], l["strategy"], l["status"]]), [["rule-x-1", "strategy-a", "rejected"], ["rule-x-1", "strategy-b", "accepted"]]);
  assert.deepEqual(verdicts[0]!["reasons"], ["new-violation"]);
  assert.deepEqual((verdicts[0]!["new"] as Array<{ ruleId: string }>).map((n) => n.ruleId), ["new-rule"]);
});

test("[VER-04] every candidate is audited in its own scratch copy on a loopback URL; the source root's treeSha256 is unchanged after the loop", async (t) => {
  const { runner, root, treeBefore, scratchRoots } = await run(t, {
    baseline: linksSnapshot([0, 1]),
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a")] },
    cases: [{ when: includes('data-a="1"'), snapshot: linksSnapshot([]) }],
  });
  const targets = runner.targets();
  assert.equal(targets.length, 2);
  assert.equal(new Set(targets.map((x) => x.servedRoot)).size, 2);
  for (const target of targets) {
    assert.notEqual(target.servedRoot, root);
    assert.match(target.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(target.pagePath, "/");
  }
  assert.deepEqual(targets.map((x) => x.watch), [["a[0]"], ["a[1]"]]);
  assert.equal(treeSha256(root), treeBefore);
  assert.deepEqual(scratchRoots, targets.map((x) => x.servedRoot));
  for (const dir of scratchRoots) assert.equal(existsSync(dir), false, "scratch copies are disposed");
});

test("[VER-06] every candidate is built from the baseline text, so the second finding's patch does not contain the first finding's edit", async (t) => {
  const { result, runner } = await run(t, {
    baseline: linksSnapshot([0, 1]),
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a")] },
    cases: [
      { when: includes('class="one" data-a="1"'), snapshot: linksSnapshot([1]) },
      { when: includes('class="two" data-a="1"'), snapshot: linksSnapshot([0]) },
    ],
  });
  assert.deepEqual(statuses(result.outcomes), ["rule-x-1:accepted", "rule-x-2:accepted"]);
  const second = result.accepted[1]!;
  assert.match(second.patch, /class="two" data-a="1"/);
  assert.doesNotMatch(second.patch, /class="one" data-a="1"/);
  assert.equal(second.patchedFiles["index.html"]!.match(/data-a="1"/g)!.length, 1);
  assert.equal(runner.served()[1]!["index.html"]!.match(/data-a="1"/g)!.length, 1);
});

test("[VER-06] after maxFixes accepted fixes the remaining findings are skipped: max-fixes", async (t) => {
  const { result, runner, lines } = await run(t, {
    baseline: linksSnapshot([0, 1, 2]),
    config: { maxFixes: 1 },
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a")] },
    cases: [{ when: includes('data-a="1"'), snapshot: linksSnapshot([1, 2]) }],
  });
  assert.deepEqual(statuses(result.outcomes), ["rule-x-1:accepted", "rule-x-2:skipped:max-fixes", "rule-x-3:skipped:max-fixes"]);
  assert.equal(runner.audits(), 1);
  assert.deepEqual(lines.filter((l) => l["event"] === "limit_hit").map((l) => [l["limit"], l["value"]]), [["max-fixes", 1]]);
});

test("[VER-07] after maxCandidates audits the rest are skipped: max-candidates; the runner counted exactly maxCandidates audits", async (t) => {
  const { result, runner, lines } = await run(t, {
    baseline: linksSnapshot([0, 1, 2]),
    config: { maxCandidates: 2 },
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a"), attrStrategy("strategy-b", "data-b")] },
    cases: [
      { when: includes('data-a="1"'), snapshot: linksSnapshot([0, 1, 2]) }, // never fixes: target still present
      { when: includes('data-b="1"'), snapshot: linksSnapshot([]) },
    ],
  });
  assert.equal(runner.audits(), 2);
  assert.equal(result.limits.candidatesUsed, 2);
  assert.deepEqual(statuses(result.outcomes), ["rule-x-1:rejected", "rule-x-1:accepted", "rule-x-2:skipped:max-candidates", "rule-x-3:skipped:max-candidates"]);
  assert.equal(lines.filter((l) => l["event"] === "limit_hit").length, 1);
});

test("[VER-07] after maxLlmCalls the LLM strategies are skipped: max-llm-calls", async (t) => {
  let calls = 0;
  const llm: LlmStrategyRunner = {
    async propose({ strategy, ctx }) {
      calls++;
      const output = { name: "Named link" };
      return { type: "result", result: strategy.toResult(ctx, output), proposal: output, requestId: `r${calls}` };
    },
  };
  const { result, runner, lines } = await run(t, {
    baseline: linksSnapshot([0, 1, 2]),
    config: { maxLlmCalls: 1 },
    llm,
    catalog: { "rule-x": [llmStrategy] },
    cases: [{ when: includes('aria-label="Named link"'), snapshot: linksSnapshot([1, 2]) }],
  });
  assert.equal(calls, 1);
  assert.equal(result.llmCalls, 1);
  assert.equal(result.limits.llmCallsUsed, 1);
  assert.equal(runner.audits(), 1);
  assert.deepEqual(statuses(result.outcomes), ["rule-x-1:accepted", "rule-x-2:skipped:max-llm-calls", "rule-x-3:skipped:max-llm-calls"]);
  const accepted = result.outcomes[0]!;
  assert.ok(accepted.status === "accepted" && accepted.verified === "verified-present-needs-review");
  assert.deepEqual(lines.filter((l) => l["event"] === "limit_hit").map((l) => l["limit"]), ["max-llm-calls"]);
});

test("[VER-07] once the deadline passes, the remaining findings are skipped: deadline", async (t) => {
  const clock = steppingClock("2026-10-14T12:00:00.000Z");
  const { result, runner } = await run(t, {
    baseline: linksSnapshot([0, 1, 2]),
    clock,
    onAudit: () => clock.advance(10 * 60 * 1000),
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a")] },
    cases: [{ when: includes('data-a="1"'), snapshot: linksSnapshot([1, 2]) }],
  });
  assert.equal(runner.audits(), 1);
  assert.equal(result.limits.deadlineHit, true);
  assert.deepEqual(statuses(result.outcomes), ["rule-x-1:accepted", "rule-x-2:skipped:deadline", "rule-x-3:skipped:deadline"]);
});

test("[FIX-08] a strategy whose edits break the bounds gate becomes gate-rejected: patch-out-of-bounds and is never audited", async (t) => {
  const evil: Strategy = {
    name: "evil",
    kind: "deterministic",
    run: (ctx) => ({ type: "plan", plan: plan("evil", [{ ...insertAttr(ctx, "data-x"), replacement: ' data-x="1"><script>alert(1)</script' }]) }),
  };
  const { result, runner, lines } = await run(t, {
    baseline: linksSnapshot([0]),
    catalog: { "rule-x": [evil] },
    cases: [],
  });
  assert.equal(runner.audits(), 0);
  assert.equal(result.limits.candidatesUsed, 0);
  assert.deepEqual(result.outcomes, [{ status: "gate-rejected", findingId: "rule-x-1", strategy: "evil", reason: "patch-out-of-bounds", proposal: null }]);
  const verdict = lines.find((l) => l["event"] === "candidate_verdict")!;
  assert.deepEqual([verdict["status"], verdict["bounds"]], ["gate-rejected", "attribute-markup"]);
});

test("[FIX-09] a suggest-only strategy produces a suggestion with a location and an empty edit list", async (t) => {
  const advice: Strategy = { name: "rule-x-advice", kind: "suggest-only", suggest: (ctx) => `Fix ${ctx.finding.node.selector} by hand` };
  const { result, findings, runner } = await run(t, { baseline: linksSnapshot([0]), catalog: { "rule-x": [advice] }, cases: [] });
  assert.equal(runner.audits(), 0);
  const o = result.outcomes[0]!;
  assert.equal(o.status, "suggest-only");
  if (o.status !== "suggest-only") return;
  assert.deepEqual([o.findingId, o.reason, o.plan.kind, o.plan.edits, o.plan.summary], ["rule-x-1", "catalog", "suggest-only", [], "Fix .one by hand"]);
  const f = findings.find((x) => x.id === o.findingId)!;
  assert.ok("startLine" in f.location && f.location.startLine === 5);
});

test("[P-3] axe incomplete findings get no outcome, keyboard findings get suggest-only and unmapped findings get unmapped", async (t) => {
  const baseline = scriptedSnapshot({
    violations: [axeRule("rule-x", [{ node: a(0) }]), axeRule("label", [{ node: injected }])],
    incomplete: [axeRule("color-contrast", [{ node: a(2) }])],
    nodes: { "div.widget": widget },
    traversal: { steps: [], stoppedBecause: "body", interactiveCandidates: [{ selector: "div.widget", tag: "div", reason: "onclick", focusable: false, reached: false, hasFocusableDescendant: false }] },
  });
  const advice: Strategy = { name: "unreachable-control-advice", kind: "suggest-only", suggest: () => "Use a button" };
  const { result, findings } = await run(t, {
    baseline,
    catalog: { "rule-x": [attrStrategy("strategy-a", "data-a")], label: [attrStrategy("strategy-a", "data-a")], "color-contrast": [attrStrategy("strategy-a", "data-a")], "unreachable-control": [advice] },
    cases: [{ when: includes('data-a="1"'), snapshot: scriptedSnapshot({ incomplete: [axeRule("color-contrast", [{ node: a(2) }])], violations: [axeRule("label", [{ node: injected }])], nodes: { "div.widget": widget }, traversal: baseline.traversal }) }],
  });
  assert.deepEqual(findings.map((f) => f.id), ["rule-x-1", "color-contrast-1", "unreachable-control-1", "label-1"]);
  assert.deepEqual(statuses(result.outcomes), ["rule-x-1:accepted", "unreachable-control-1:suggest-only:catalog", "label-1:unmapped:no-candidate"]);
});

test("[CS-10] with llm null an LLM strategy becomes suggest-only: llm-disabled", async (t) => {
  const { result, runner } = await run(t, { baseline: linksSnapshot([0]), catalog: { "rule-x": [llmStrategy] }, cases: [], llm: null });
  assert.equal(runner.audits(), 0);
  const o = result.outcomes[0]!;
  assert.ok(o.status === "suggest-only");
  if (o.status !== "suggest-only") return;
  assert.deepEqual([o.reason, o.plan.strategy, o.plan.kind, o.plan.edits], ["llm-disabled", "aria-label-llm", "llm", []]);
  assert.equal(result.llmCalls, 0);
});

// Task 22: the label strategies inside the loop, with the real catalog.

const TWO_FIELDS = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Two fields</title></head>",
  "<body>",
  "<form>",
  '<label>First</label><input type="text">',
  '<label>Second</label><input type="text">',
  "</form>",
  "</body>",
  "</html>",
  "",
].join("\n");
const textInput = (i: number, attrs: Record<string, string> = {}) => makeNode({ tag: "input", selector: `input:nth-of-type(${i + 1})`, attrs: { type: "text", ...attrs }, domTagIndex: i, domTagCount: 2 });

test("[FIX-10] in one run two unlabeled inputs without names get field-1 and then field-2", async (t) => {
  const { result } = await run(t, {
    page: TWO_FIELDS,
    baseline: scriptedSnapshot({ violations: [axeRule("label", [{ node: textInput(0) }, { node: textInput(1) }], "critical")] }),
    cases: [
      { when: includes('<input type="text" id="field-1">'), snapshot: scriptedSnapshot({ violations: [axeRule("label", [{ node: textInput(1) }], "critical")] }) },
      { when: includes('<input type="text" id="field-2">'), snapshot: scriptedSnapshot({ violations: [axeRule("label", [{ node: textInput(0) }], "critical")] }) },
    ],
  });
  assert.deepEqual(statuses(result.outcomes), ["label-1:accepted", "label-2:accepted"]);
  assert.deepEqual(result.accepted.map((c) => [c.plan.strategy, c.plan.generatedIds]), [["label-associate", ["field-1"]], ["label-associate", ["field-2"]]]);
  const combined = combineEdits({ "index.html": TWO_FIELDS }, result.accepted, []);
  assert.deepEqual(combined.conflicts, []);
  assert.match(combined.files["index.html"]!, /<label for="field-1">First<\/label><input type="text" id="field-1">\n<label for="field-2">Second<\/label><input type="text" id="field-2">/);
});

const SIGNUP = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Signup</title></head>",
  "<body>",
  '<form class="signup"><label>Email</label><input type="email" name="email"></form>',
  '<script src="newsletter.js"></script>',
  "</body>",
  "</html>",
  "",
].join("\n");

test("[VER-03] the label rejection moves to label-fresh-id", async (t) => {
  const signup = (attrs: Record<string, string> = {}) => makeNode({ tag: "input", selector: 'input[name="email"]', attrs: { type: "email", name: "email", ...attrs }, domTagIndex: 0, domTagCount: 2 });
  const injectedEmail = makeNode({ tag: "input", selector: "#email", attrs: { id: "email", type: "email" }, domTagIndex: 1, domTagCount: 2 });
  const remaining = axeRule("label", [{ node: injectedEmail }], "critical");
  const { result, runner } = await run(t, {
    page: SIGNUP,
    baseline: scriptedSnapshot({ violations: [axeRule("label", [{ node: signup() }, { node: injectedEmail }], "critical")], domIds: ["email"] }),
    cases: [
      { when: includes('<input type="email" name="email" id="email">'), snapshot: scriptedSnapshot({ violations: [remaining], incomplete: [axeRule("duplicate-id-aria", [{ node: signup({ id: "email" }) }], "critical")], domIds: ["email", "email"] }) },
      { when: includes('id="email-2"'), snapshot: scriptedSnapshot({ violations: [remaining], domIds: ["email", "email-2"] }) },
    ],
  });
  assert.equal(runner.audits(), 2);
  assert.deepEqual(statuses(result.outcomes), ["label-1:rejected", "label-1:accepted", "label-2:unmapped:no-candidate"]);
  const [rejected, accepted] = result.outcomes;
  assert.ok(rejected!.status === "rejected" && rejected!.candidate.plan.strategy === "label-associate");
  if (rejected!.status !== "rejected") return;
  assert.deepEqual(rejected!.verdict.status === "rejected" ? rejected!.verdict.reasons : [], ["new-incomplete"]);
  assert.deepEqual(rejected!.newFindings.map((n) => [n.ruleId, n.anchor]), [["duplicate-id-aria", "src:index.html#input[0]"]]);
  assert.ok(accepted!.status === "accepted" && accepted!.verified === "verified" && accepted!.candidate.plan.strategy === "label-fresh-id");
  if (accepted!.status !== "accepted") return;
  assert.match(accepted!.candidate.patch, /id="email-2"/);
  assert.deepEqual(accepted!.candidate.plan.generatedIds, ["email-2"]);
});

// The full storefront loop on recordings with the strict fake and fixtures/llm/storefront.json (plan Task 28, spec 5.15).

const outcomesOf = (r: Awaited<ReturnType<typeof runAuditRecorded>>, ruleId: string, className: string) => {
  const f = r.findings.find((x) => x.ruleId === ruleId && x.node.attrs["class"] === className)!;
  assert.ok(f, `no ${ruleId} finding on .${className}`);
  return r.outcomes.filter((o) => findingIdOf(o) === f.id);
};

test("[CS-4] the full storefront loop on recordings with the strict fake matches spec 5.15", async () => {
  const r = await runAuditRecorded("storefront");
  const s = r.summary;
  assert.deepEqual([s.violations, s.incomplete, s.keyboard, s.accepted, s.verified, s.verifiedNeedsReview, s.rejected, s.gateRejected, s.suggestOnly, s.unmapped, s.conflicts], [15, 1, 3, 11, 3, 8, 2, 1, 6, 1, 0]);
  assert.equal(r.limits.candidatesUsed, 13);
  assert.equal(r.llm.calls, 10);
  assert.equal(r.combined!.remaining.filter((f) => f.status === "violation" && f.source === "axe").length, 4);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.combined!.included.length, 11);
});

test("[VER-03] the promo link's attempt 1 \"Shop deals\" is rejected with new-violation label-content-name-mismatch, and attempt 2 \"Sale: shop deals\" is accepted (recorded)", async () => {
  const r = await runAuditRecorded("storefront");
  const outs = outcomesOf(r, "link-name", "promo");
  assert.deepEqual(outs.map((o) => o.status), ["rejected", "accepted"]);
  const [rejected, accepted] = outs;
  if (rejected!.status !== "rejected" || accepted!.status !== "accepted") return;
  assert.deepEqual([rejected!.candidate.plan.llm?.attempt, (rejected!.candidate.plan.llm?.proposal as { name?: string } | undefined)?.name], [1, "Shop deals"]);
  assert.deepEqual(rejected!.verdict.status === "rejected" ? rejected!.verdict.reasons : [], ["new-violation"]);
  assert.deepEqual(rejected!.newFindings.map((n) => n.ruleId), ["label-content-name-mismatch"]);
  assert.match(rejected!.candidate.patch, /aria-label="Shop deals"/);
  assert.equal(accepted!.candidate.plan.llm?.attempt, 2);
  assert.match(accepted!.candidate.patch, /aria-label="Sale: shop deals"/);
  assert.equal(accepted!.verified, "verified-present-needs-review");
});

test("[LLM-02] the jacket-1 proposal \"jacket.png\" is gate-rejected (alt-is-filename, not audited) and attempt 2 is accepted", async () => {
  const r = await runAuditRecorded("storefront");
  const jacket1 = r.findings.find((f) => f.ruleId === "image-alt" && f.node.domTagIndex === 1)!;
  const outs = r.outcomes.filter((o) => findingIdOf(o) === jacket1.id);
  assert.deepEqual(statuses(outs), [`${jacket1.id}:gate-rejected:alt-is-filename`, `${jacket1.id}:accepted`]);
  const [gate, accepted] = outs;
  assert.deepEqual(gate!.status === "gate-rejected" ? gate!.proposal : null, { kind: "informative", alt: "jacket.png", reason: "file name" });
  assert.ok(accepted!.status === "accepted" && accepted!.candidate.plan.llm?.attempt === 2);
  assert.match(accepted!.status === "accepted" ? accepted!.candidate.patch : "", /alt="Green waterproof trail jacket with hood"/);
});

test("[FIX-06] the divider ends as suggest-only: decorative-needs-decision", async () => {
  const r = await runAuditRecorded("storefront");
  const divider = r.findings.find((f) => f.ruleId === "image-alt" && f.node.domTagIndex === 3)!;
  const outs = r.outcomes.filter((o) => findingIdOf(o) === divider.id);
  assert.deepEqual(statuses(outs), [`${divider.id}:suggest-only:decorative-needs-decision`]);
  assert.ok(outs[0]!.status === "suggest-only" && outs[0]!.plan.edits.length === 0 && /visual separator/.test(outs[0]!.plan.summary));
});
