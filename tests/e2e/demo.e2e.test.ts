// The offline demo end to end (plan Task 34; CS-1, CLI-03, LLM-09): `node scripts/demo.ts` in a child process with a
// minimal environment. Recorded mode needs no browser; browser mode runs the same pipeline against a real Chromium.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sarifLogSchema } from "../../src/contracts/sarif.ts";
import { guardNodeOptions } from "../setup/guard-options.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const DEMO = join(PROJECT_ROOT, "scripts", "demo.ts");

type Spawned = { status: number | null; stdout: string; stderr: string; ms: number };

/** Runs `node scripts/demo.ts` with an explicit minimal environment: never the inherited shell, never a key. */
function spawnDemo(args: string[], env: Record<string, string> = {}): Spawned {
  const started = Date.now();
  const result = spawnSync(process.execPath, [DEMO, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_OPTIONS: guardNodeOptions(), ...env },
  });
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
}

const rejectedLines = (stdout: string): string[] => stdout.split("\n").filter((l) => l.includes("REJECTED"));
/** The key of every LLM call, in the order the loop made them (spec 5.12: component llm, event call). */
const llmKeys = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { component?: string; event?: string; key?: string })
    .filter((e) => e.component === "llm" && e.event === "call")
    .map((e) => e.key!);

test("[CLI-03] [CS-1] npm run demo in recorded mode exits 0 without a browser, in under 10 s", (t) => {
  const out = tmpDir(t, "a11y-demo-");
  const r = spawnDemo(["--out", out]); // no A11Y_BROWSER_PATH, no REQUIRE_BROWSER, no key
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  for (const f of ["report.html", "fixes.patch", "results.sarif", "audit.json"]) assert.ok(existsSync(join(out, f)), f);
  const lines = r.stdout.trimEnd().split("\n");
  assert.match(lines[0]!, /^a11y-fixgate demo \| audit: recorded \(no browser\) \| LLM: fake, strict \(fixtures\/llm\/storefront\.json\) \| lang: en$/);
  assert.match(r.stdout, /^Page: fixtures\/storefront\/index\.html served at http:\/\/127\.0\.0\.1:\d+\/ {2}axe-core 4\.14\.0 {2}tags: wcag2a wcag2aa wcag21a wcag21aa wcag22a wcag22aa$/m);
  assert.match(r.stdout, /^Baseline: 15 axe violations \(8 rules\), 1 needs-review, 3 keyboard findings$/m);
  assert.match(r.stdout, /^Mapping: 18 mapped \(ordinal 12, signature 6\), 1 unmapped/m);
  assert.match(r.stdout, /^Combined audit \(11 accepted fixes merged, 0 conflicts\): 4 axe violations remaining/m);
  assert.match(lines.at(-1)!, /^Finished in [\d.]+ s \(.*recorded mode \(no browser\).*\)/);
  // Stderr is JSON log lines only.
  for (const line of r.stderr.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), line);
});

test("[CS-1] the demo prints exactly two REJECTED lines, first the promo link with label-content-name-mismatch, then the email field with duplicate-id-aria", (t) => {
  const r = spawnDemo(["--out", tmpDir(t, "a11y-demo-")]);
  assert.equal(r.status, 0, r.stderr);
  const rejected = rejectedLines(r.stdout);
  assert.equal(rejected.length, 2, rejected.join("\n"));
  assert.match(rejected[0]!, /link-name .*aria-label-llm .*llm .*REJECTED .*aria-label="Shop deals" passed every value gate; re-audit: new-violation: label-content-name-mismatch/);
  assert.match(rejected[1]!, /label .*label-associate .*deterministic .*REJECTED .*id="email" \/ for="email"; re-audit: new-incomplete: duplicate-id-aria/);
  // Each rejection is followed by the accepted retry.
  const all = r.stdout.split("\n");
  assert.match(all[all.indexOf(rejected[0]!) + 1]!, /aria-label-llm .*accepted .*aria-label="Sale: shop deals" \(attempt 2\)/);
  assert.match(all[all.indexOf(rejected[1]!) + 1]!, /label-fresh-id .*accepted .*id="email-2" \/ for="email-2"/);
  // The screen reader view of the promo link, before and after.
  assert.match(r.stdout, /^Screen reader view, a\.promo: {2}- link {2}-> {2}\+ link "Sale: shop deals"$/m);
});

test('[CS-1] the totals line reads "Accepted 11 (verified 3, needs human review 8" and the outputs line names results.sarif (18 results)', (t) => {
  const out = tmpDir(t, "a11y-demo-");
  const r = spawnDemo(["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Accepted 11 \(verified 3, needs human review 8: 7 LLM \+ 1 design review\) \| rejected 2 \| gate-rejected 1 \(retried\) \| suggest-only 6 \| unmapped 1/m);
  const outputs = r.stdout.split("\n").find((l) => l.startsWith("Outputs:"))!;
  assert.match(outputs, /^Outputs: \S*report\.html {2}fixes\.patch \(1 file\) {2}results\.sarif \(18 results\) {2}audit\.json$/);
  assert.equal(sarifLogSchema.parse(JSON.parse(readFileSync(join(out, "results.sarif"), "utf8"))).runs[0]!.results.length, 18);
  // Recorded mode has no browser, so no screenshot exists and the line does not claim any.
  assert.ok(!existsSync(join(out, "screenshots", "page.png")));
  assert.ok(!outputs.includes("screenshots"));
});

test("[CS-1] the demo ignores LLM_PROVIDER and never needs a key", (t) => {
  const r = spawnDemo(["--out", tmpDir(t, "a11y-demo-")], { LLM_PROVIDER: "openai-compatible" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split("\n")[0]!, /LLM: fake, strict/);
});

test("[AUD-05] demo --browser with a missing A11Y_BROWSER_PATH exits 3 with the NO_BROWSER message", (t) => {
  const r = spawnDemo(["--browser", "--out", tmpDir(t, "a11y-demo-")], { A11Y_BROWSER_PATH: join(PROJECT_ROOT, "no-such-chromium") });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /NO_BROWSER: .*A11Y_BROWSER_PATH.*npm run browser:install/);
});

test("[LLM-09] browser mode logs the same LLM keys as recorded mode", (t) => {
  const chromium = browserPathOrSkip(t);
  if (!chromium) return;
  const recorded = spawnDemo(["--out", tmpDir(t, "a11y-demo-")]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const liveOut = tmpDir(t, "a11y-demo-");
  const live = spawnDemo(["--browser", "--out", liveOut], { A11Y_BROWSER_PATH: chromium });
  assert.equal(live.status, 0, live.stderr);
  assert.ok(existsSync(join(liveOut, "screenshots", "page.png")) && existsSync(join(liveOut, "screenshots", "page.after.png")));
  assert.match(live.stdout, /^Outputs: .*audit\.json {2}screenshots\/page\.png, page\.after\.png$/m);
  const keys = llmKeys(recorded.stderr);
  assert.equal(keys.length, 10); // spec 5.15: rows 3, 5, 6, 7, 10, 11 once; rows 4 and 17 twice
  assert.deepEqual(llmKeys(live.stderr), keys);
  // Same outcomes in both modes; browser mode also wrote the screenshots.
  assert.equal(rejectedLines(live.stdout).length, 2);
  assert.match(live.stdout.trimEnd().split("\n").at(-1)!, /Chromium, \d+ audits\)\. npm run demo without flags replays these recordings/);
});
