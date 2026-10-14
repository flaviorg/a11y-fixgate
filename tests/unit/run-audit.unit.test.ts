// The run orchestrator (plan Task 20; spec 5.6 "Combine", 5.8) over a scripted runner and real scratch copies.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { CombinedMismatchError, runAudit } from "../../src/app/run-audit.ts";
import { AppError } from "../../src/domain/errors.ts";
import { auditConfigSchema } from "../../src/contracts/config.ts";
import type { AuditConfig } from "../../src/contracts/config.ts";
import type { NodeDescriptor } from "../../src/contracts/finding.ts";
import type { Edit, FixPlan } from "../../src/contracts/fix.ts";
import type { AuditSnapshot } from "../../src/contracts/snapshot.ts";
import type { FixContext, Strategy } from "../../src/domain/fix/types.ts";
import { steppingClock } from "../../src/infra/clock.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { existsInsideRoot, readInsideRoot } from "../../src/infra/safe-read.ts";
import { scratchFactory } from "../../src/infra/scratch.ts";
import { staticServerFactory } from "../../src/infra/static-server.ts";
import { treeSha256 } from "../../src/infra/tree-hash.ts";
import { formatSummary, formatSummaryJson } from "../../src/output/summary.ts";
import { SITES_DIR } from "../helpers/fixtures.ts";
import { scriptedRunner } from "../helpers/scripted-runner.ts";
import type { ScriptedCase } from "../helpers/scripted-runner.ts";
import { axeRule, makeNode, scriptedSnapshot } from "../helpers/snapshots.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

const PAGE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Run test</title></head>",
  "<body>",
  '<a href="/one" class="one">One</a>',
  '<a href="/two" class="two">Two</a>',
  "</body>",
  "</html>",
  "",
].join("\n");
const LINKS = ["one", "two"] as const;
const a = (i: 0 | 1): NodeDescriptor => makeNode({ tag: "a", selector: `.${LINKS[i]}`, attrs: { href: `/${LINKS[i]}`, class: LINKS[i] }, domTagIndex: i, domTagCount: 2 });
const links = (indexes: Array<0 | 1>, extra: Parameters<typeof scriptedSnapshot>[0] = {}): AuditSnapshot =>
  scriptedSnapshot({ violations: indexes.length ? [axeRule("rule-x", indexes.map((i) => ({ node: a(i) })))] : [], domIds: [], ...extra });
const includes = (text: string) => (files: Record<string, string>) => files["index.html"]?.includes(text) ?? false;
const not = (f: (files: Record<string, string>) => boolean) => (files: Record<string, string>) => !f(files);

function insertAttr(ctx: FixContext, attr: string): Edit {
  const at = ctx.location.startTag.endOffset - 1;
  return { range: { file: ctx.location.file, startOffset: at, endOffset: at }, replacement: ` ${attr}="1"`, kind: "attribute", startTag: { file: ctx.location.file, ...ctx.location.startTag } };
}
const strategy: Strategy = {
  name: "add-data",
  kind: "deterministic",
  run: (ctx): { type: "plan"; plan: FixPlan } => ({
    type: "plan",
    plan: { strategy: "add-data", kind: "deterministic", edits: [insertAttr(ctx, "data-fix")], summary: 'data-fix="1"', needsHumanReview: false, reviewReason: null, generatedIds: [] },
  }),
};
const CATALOG = { "rule-x": [strategy] };

async function run(t: TestContext, opts: { cases: ScriptedCase[]; files?: Record<string, string>; config?: Partial<AuditConfig>; root?: string; clock?: ReturnType<typeof steppingClock>; onAudit?: () => void; catalog?: Record<string, Strategy[]> }) {
  const root = opts.root ?? tmpDir(t, "a11y-run-");
  if (!opts.root) writeTree(root, opts.files ?? { "index.html": PAGE });
  const out = tmpDir(t, "a11y-out-");
  const config = auditConfigSchema.parse({ sourceRoot: root, out, lang: "en", browser: { executablePath: null, source: "recorded" }, llm: { provider: "none" }, ...opts.config });
  const runner = scriptedRunner(opts.cases, { onAudit: opts.onAudit });
  const clock = opts.clock ?? steppingClock("2026-10-14T12:00:00.000Z");
  const before = treeSha256(root);
  const result = await runAudit(config, {
    runner,
    llm: null,
    servers: staticServerFactory,
    clock,
    logger: createLogger({ component: "loop", level: "error", write: () => {} }),
    scratch: scratchFactory,
    readPage: (r, rel) => readInsideRoot(r, rel).toString("utf8"),
    exists: existsInsideRoot,
    catalog: opts.catalog ?? CATALOG,
  });
  if (!opts.config?.write) assert.equal(treeSha256(root), before, "the source root is never written without --write");
  return { result, runner, root };
}

const fixedOne = includes('class="one" data-fix="1"');
const fixedTwo = includes('class="two" data-fix="1"');
const baselineCase: ScriptedCase = { when: not(includes("data-fix")), snapshot: links([0, 1]) };

test("[VER-04] the baseline is audited on a scratch copy, never on the source root itself", async (t) => {
  const { runner, root, result } = await run(t, {
    cases: [baselineCase, { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: links([]) }, { when: fixedOne, snapshot: links([1]) }, { when: fixedTwo, snapshot: links([0]) }],
  });
  const first = runner.targets()[0]!;
  assert.notEqual(first.servedRoot, root);
  assert.deepEqual(first.watch, []);
  assert.deepEqual(runner.options()[0], { screenshot: "page.png" });
  assert.equal(result.baseline.pagePath, "/");
  assert.deepEqual(result.findings.map((f) => f.id), ["rule-x-1", "rule-x-2"]);
});

test("[VER-05] the combined tree is audited once and its snapshot is the after state; a combined snapshot that still contains an accepted target adds combined-audit-mismatch:<fp>", async (t) => {
  const combinedOk = await run(t, {
    cases: [baselineCase, { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: links([], { title: "combined" }) }, { when: fixedOne, snapshot: links([1]) }, { when: fixedTwo, snapshot: links([0]) }],
  });
  const r = combinedOk.result;
  assert.equal(combinedOk.runner.audits(), 4);
  const last = combinedOk.runner.targets()[3]!;
  assert.deepEqual(last.watch, ["a[0]", "a[1]"]);
  assert.deepEqual(combinedOk.runner.options()[3], { screenshot: "page.after.png" });
  assert.match(combinedOk.runner.served()[3]!["index.html"]!, /class="one" data-fix="1"[\s\S]*class="two" data-fix="1"/);
  assert.ok(r.combined);
  assert.equal(r.combined!.snapshot.title, "combined");
  assert.deepEqual(r.combined!.included, ["rule-x-1", "rule-x-2"]);
  assert.deepEqual(r.combined!.remaining, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(Object.keys(r.diffs), ["index.html"]);
  assert.match(r.diffs["index.html"]!, /^--- a\/index\.html/m);

  // The combined audit still flags link two; as in a real browser, its descriptor carries the attribute the fix added.
  const twoFixed = { ...a(1), attrs: { ...a(1).attrs, "data-fix": "1" } };
  const contradicted = await run(t, {
    cases: [
      baselineCase,
      { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: scriptedSnapshot({ violations: [axeRule("rule-x", [{ node: twoFixed }])] }) },
      { when: fixedOne, snapshot: links([1]) },
      { when: fixedTwo, snapshot: links([0]) },
    ],
  });
  const fp = contradicted.result.findings.find((f) => f.id === "rule-x-2")!.fingerprint;
  assert.deepEqual(contradicted.result.warnings, [`combined-audit-mismatch:${fp}`]);
});

test("[CLI-02] without --write, remainingInSource equals the baseline findings and fixableByPatch counts the included targets", async (t) => {
  const { result } = await run(t, {
    cases: [baselineCase, { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: links([]) }, { when: fixedOne, snapshot: links([1]) }, { when: fixedTwo, snapshot: links([0]) }],
  });
  assert.equal(result.summary.remainingInSource, result.findings.length);
  assert.equal(result.summary.remainingInSource, 2);
  assert.equal(result.summary.fixableByPatch, 2);
  assert.deepEqual(
    { violations: result.summary.violations, accepted: result.summary.accepted, verified: result.summary.verified, rejected: result.summary.rejected },
    { violations: 2, accepted: 2, verified: 2, rejected: 0 },
  );
  assert.deepEqual(result.llm, { provider: "none", calls: 0, promptVersion: "v1" });
  assert.deepEqual(JSON.parse(formatSummaryJson(result)), result.summary);
});

test("[VER-07] the combined audit still runs after the deadline", async (t) => {
  const clock = steppingClock("2026-10-14T12:00:00.000Z");
  let audits = 0;
  const { result, runner } = await run(t, {
    clock,
    config: { deadlineMs: 60_000 },
    onAudit: () => {
      if (++audits === 2) clock.advance(10 * 60 * 1000); // the first candidate audit passes the deadline
    },
    cases: [baselineCase, { when: fixedOne, snapshot: links([1]) }],
  });
  assert.deepEqual(result.outcomes.map((o) => o.status), ["accepted", "skipped"]);
  assert.equal(result.limits.deadlineHit, true);
  assert.equal(runner.audits(), 3);
  assert.deepEqual(runner.targets()[2]!.watch, ["a[0]"]);
  assert.ok(result.combined);
});

test("[RF-1] a page with zero findings yields no outcomes, no combined audit and an empty diff map", async (t) => {
  const { result, runner } = await run(t, { root: join(SITES_DIR, "clean"), cases: [{ when: () => true, snapshot: scriptedSnapshot({ domIds: ["main"] }) }] });
  assert.equal(runner.audits(), 1);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.outcomes, []);
  assert.equal(result.combined, null);
  assert.deepEqual(result.diffs, {});
  assert.equal(result.summary.fixableByPatch, 0);
  assert.match(formatSummary(result, { mode: "recorded", llmLabel: "none" }), /No findings/);
});

test("[RF-2] an out dir inside the source root is excluded from the baseline scratch copy", async (t) => {
  const root = tmpDir(t, "a11y-run-");
  writeTree(root, { "index.html": PAGE, "a11y-report/report.html": "<!doctype html><title>old report</title>" });
  const { runner } = await run(t, { root, config: { out: join(root, "a11y-report") }, cases: [{ when: () => true, snapshot: links([]) }] });
  assert.deepEqual(Object.keys(runner.served()[0]!), ["index.html"]);
});

test("[P-15] formatSummary prints one line per outcome in finding order, REJECTED in upper case with the new rule ids", async (t) => {
  const newRule = axeRule("label-content-name-mismatch", [{ node: a(1) }]);
  const { result } = await run(t, {
    files: { "index.html": PAGE },
    cases: [baselineCase, { when: fixedOne, snapshot: links([1], { violations: [axeRule("rule-x", [{ node: a(1) }]), newRule] }) }, { when: fixedTwo, snapshot: links([0]) }],
  });
  const text = formatSummary(result, { mode: "recorded", llmLabel: "none" });
  const lines = text.split("\n");
  const rejected = lines.filter((l) => l.includes("REJECTED"));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!, /rule-x/);
  assert.match(rejected[0]!, /label-content-name-mismatch/);
  assert.ok(lines.findIndex((l) => l.includes("REJECTED")) < lines.findIndex((l) => / accepted /.test(l)));
  assert.match(text, /Accepted 1 \(verified 1, needs human review 0\) \| rejected 1/);
});

// Task 31: --write (OUT-05, VER-05, CLI-02). Link one gets a verified fix, link two a fix flagged for human review.

const hasReview = includes('data-review="1"');
const reviewStrategy: Strategy = {
  name: "add-review",
  kind: "deterministic",
  run: (ctx): { type: "plan"; plan: FixPlan } => ({
    type: "plan",
    plan: { strategy: "add-review", kind: "deterministic", edits: [insertAttr(ctx, "data-review")], summary: 'data-review="1"', needsHumanReview: true, reviewReason: "design-review", generatedIds: [] },
  }),
};
const picky: Strategy = { name: "pick", kind: "deterministic", run: (ctx) => (ctx.finding.node.attrs["class"] === "one" ? strategy.run(ctx) : reviewStrategy.run(ctx)) };
const MIXED = { "rule-x": [picky] };
const mixedBaseline: ScriptedCase = { when: (f) => !includes("data-fix")(f) && !hasReview(f), snapshot: links([0, 1]) };
const onlyVerified = (f: Record<string, string>) => fixedOne(f) && !hasReview(f);

test("[OUT-05] write chooses only verified fixes and audits the subset when it differs from the combined set", async (t) => {
  let calls = 0;
  const { result, runner, root } = await run(t, {
    catalog: MIXED,
    config: { write: true },
    onAudit: () => void calls++,
    cases: [mixedBaseline, { when: (f) => fixedOne(f) && hasReview(f), snapshot: links([]) }, { when: onlyVerified, snapshot: links([1]) }, { when: (f) => hasReview(f) && !fixedOne(f), snapshot: links([0]) }],
  });
  assert.deepEqual(result.combined!.included, ["rule-x-1", "rule-x-2"]);
  assert.equal(runner.audits(), 5, "baseline, two candidates, the combined audit and the subset audit");
  assert.deepEqual(runner.targets()[4]!.watch, ["a[0]"]);
  assert.deepEqual(runner.options()[4], {});
  assert.equal(result.writeSubsetAudited, true);
  assert.deepEqual(result.written, { files: ["index.html"], fixes: ["rule-x-1"], remaining: result.written!.remaining });
  const onDisk = readFileSync(join(root, "index.html"), "utf8");
  assert.match(onDisk, /class="one" data-fix="1"/);
  assert.equal(onDisk.includes("data-review"), false, "the fix flagged for review is not written");
  assert.deepEqual(result.writtenFiles, { "index.html": onDisk });
  assert.equal(runner.served()[4]!["index.html"], onDisk, "the written file equals the audited subset tree");
  assert.match(result.combinedFiles["index.html"]!, /data-review="1"/);
  assert.ok(result.warnings.includes("left-in-patch:rule-x-2"), result.warnings.join());
  assert.equal(calls, 5);
});

test("[OUT-05] when every included fix is verified the combined tree is written without another audit", async (t) => {
  const { result, runner, root } = await run(t, {
    config: { write: true },
    cases: [baselineCase, { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: links([]) }, { when: fixedOne, snapshot: links([1]) }, { when: fixedTwo, snapshot: links([0]) }],
  });
  assert.equal(runner.audits(), 4);
  assert.equal(result.writeSubsetAudited, false);
  assert.deepEqual(result.written!.fixes, ["rule-x-1", "rule-x-2"]);
  assert.deepEqual(result.written!.remaining, []);
  assert.equal(result.summary.remainingInSource, 0);
  assert.equal(result.summary.fixableByPatch, 0);
  assert.equal(readFileSync(join(root, "index.html"), "utf8"), result.combinedFiles["index.html"]);
});

test("[CLI-02] after a write, remainingInSource is the audit of the written tree; a needs-review fix never lowers it", async (t) => {
  const { result } = await run(t, {
    catalog: MIXED,
    config: { write: true },
    cases: [mixedBaseline, { when: (f) => fixedOne(f) && hasReview(f), snapshot: links([]) }, { when: onlyVerified, snapshot: links([1]) }, { when: (f) => hasReview(f) && !fixedOne(f), snapshot: links([0]) }],
  });
  assert.equal(result.findings.length, 2, "the baseline findings are unchanged");
  assert.equal(result.summary.remainingInSource, 1, "link two stays: its accepted fix is flagged for review");
  assert.deepEqual(result.written!.remaining.map((f) => f.node.attrs["class"]), ["two"]);
  assert.equal(result.summary.fixableByPatch, 1, "the patch would now remove only the unwritten fix");
  assert.equal(result.summary.accepted, 2);
});

test("[OUT-05] --write with no verified fix writes nothing and keeps the baseline as what remains", async (t) => {
  const reviewOnly: Record<string, Strategy[]> = { "rule-x": [reviewStrategy] };
  const { result } = await run(t, {
    catalog: reviewOnly,
    config: { write: true },
    cases: [mixedBaseline, { when: (f) => hasReview(f), snapshot: links([]) }],
  });
  assert.deepEqual(result.written, { files: [], fixes: [], remaining: result.findings });
  assert.equal(result.summary.remainingInSource, 2);
  assert.deepEqual(result.writtenFiles, {});
});

test("[VER-05] a contradicting subset snapshot gives COMBINED_MISMATCH and writes nothing", async (t) => {
  let calls = 0;
  const oneFixed = { ...a(0), attrs: { ...a(0).attrs, "data-fix": "1" } };
  const contradicted = scriptedSnapshot({ violations: [axeRule("rule-x", [{ node: oneFixed }, { node: a(1) }])] });
  const root = tmpDir(t, "a11y-run-");
  writeTree(root, { "index.html": PAGE });
  const before = readFileSync(join(root, "index.html"), "utf8");
  await assert.rejects(
    run(t, {
      root,
      catalog: MIXED,
      config: { write: true },
      onAudit: () => void calls++,
      cases: [
        mixedBaseline,
        { when: (f) => onlyVerified(f) && calls === 5, snapshot: contradicted },
        { when: (f) => fixedOne(f) && hasReview(f), snapshot: links([]) },
        { when: onlyVerified, snapshot: links([1]) },
        { when: (f) => hasReview(f) && !fixedOne(f), snapshot: links([0]) },
      ],
    }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "COMBINED_MISMATCH");
      assert.equal(err.message, "Combined audit disagrees with per-fix verification; nothing written. See warnings in audit.json");
      assert.ok(err instanceof CombinedMismatchError);
      assert.ok(err.run.warnings.some((w) => w.startsWith("combined-audit-mismatch:")));
      assert.equal(err.run.written, null);
      return true;
    },
  );
  assert.equal(readFileSync(join(root, "index.html"), "utf8"), before, "nothing was written");
});

test("[VER-05] a combined-audit-mismatch warning from the combined audit also blocks the write", async (t) => {
  const twoFixed = { ...a(1), attrs: { ...a(1).attrs, "data-fix": "1" } };
  const root = tmpDir(t, "a11y-run-");
  writeTree(root, { "index.html": PAGE });
  await assert.rejects(
    run(t, {
      root,
      config: { write: true },
      cases: [
        baselineCase,
        { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: scriptedSnapshot({ violations: [axeRule("rule-x", [{ node: twoFixed }])] }) },
        { when: fixedOne, snapshot: links([1]) },
        { when: fixedTwo, snapshot: links([0]) },
      ],
    }),
    (err: unknown) => err instanceof AppError && err.code === "COMBINED_MISMATCH",
  );
  assert.equal(readFileSync(join(root, "index.html"), "utf8"), PAGE);
});

test("[OUT-05] a target that changed after the audit refuses the write, and a symlinked target is UNSAFE_PATH", async (t) => {
  const root = tmpDir(t, "a11y-run-");
  writeTree(root, { "index.html": PAGE });
  const outside = join(tmpDir(t, "a11y-outside-"), "elsewhere.html");
  writeFileSync(outside, "<p>not yours</p>");
  let calls = 0;
  const cases: ScriptedCase[] = [baselineCase, { when: (f) => fixedOne(f) && fixedTwo(f), snapshot: links([]) }, { when: fixedOne, snapshot: links([1]) }, { when: fixedTwo, snapshot: links([0]) }];
  await assert.rejects(
    run(t, {
      root,
      config: { write: true },
      cases,
      onAudit: () => {
        if (++calls === 4) {
          // After the last audit and before the write: the page is replaced by a symlink to a file outside the root.
          rmSync(join(root, "index.html"));
          symlinkSync(outside, join(root, "index.html"));
        }
      },
    }),
    (err: unknown) => err instanceof AppError && err.code === "UNSAFE_PATH",
  );
  assert.equal(readFileSync(outside, "utf8"), "<p>not yours</p>", "nothing was written through the link");

  const root2 = tmpDir(t, "a11y-run-");
  writeTree(root2, { "index.html": PAGE });
  calls = 0;
  await assert.rejects(
    run(t, {
      root: root2,
      config: { write: true },
      cases,
      onAudit: () => {
        if (++calls === 4) writeFileSync(join(root2, "index.html"), PAGE + "<!-- edited while the audit ran -->\n");
      },
    }),
    (err: unknown) => err instanceof CombinedMismatchError,
  );
  assert.equal(readFileSync(join(root2, "index.html"), "utf8").includes("data-fix"), false);
});
