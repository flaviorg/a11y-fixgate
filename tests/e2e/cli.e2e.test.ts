// The CLI end to end (plan Task 33; CLI-01, CLI-02, CLI-04, CLI-05, AUD-05, LLM-10, CS-10, RF-2): the real
// `node src/cli.ts audit` in a child process with a minimal environment, mostly over the recorded audits.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AuditResult } from "../../src/contracts/result.ts";
import { sarifLogSchema } from "../../src/contracts/sarif.ts";
import { guardNodeOptions } from "../setup/guard-options.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { FIXTURE_ROOT, SITES_DIR } from "../helpers/fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const AUDITS = join(PROJECT_ROOT, "tests", "fixtures", "audits");
const CLI = join(PROJECT_ROOT, "src", "cli.ts");

type Spawned = { status: number | null; stdout: string; stderr: string };

/** Runs `node <tool>/src/cli.ts audit ...` with an explicit minimal environment: never the inherited shell, never a key unless the case passes one. */
function spawnCli(args: string[], { cwd, env = {} }: { cwd: string; env?: Record<string, string> }): Spawned {
  const result = spawnSync(process.execPath, [CLI, "audit", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_OPTIONS: guardNodeOptions(), ...env },
  });
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(...parts), "utf8")) as T;
/** The storefront, strict fake, lang en: the recorded `storefront` scenario. */
const storefrontArgs = (out: string, src = "fixtures/storefront"): string[] => ["--src", src, "--lang", "en", "--strict-fake", "--recorded", AUDITS, "--out", out];

test("[CLI-01] the storefront recorded run exits 0 and writes report.html, fixes.patch, results.sarif and audit.json", (t) => {
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli(storefrontArgs(out), { cwd: PROJECT_ROOT });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["report.html", "fixes.patch", "results.sarif", "audit.json"]) assert.ok(existsSync(join(out, f)), f);
  assert.match(r.stdout, /Accepted 11 \(verified 3, needs human review 8: 7 LLM \+ 1 design review\) \| rejected 2 \| gate-rejected 1 \(retried\) \| suggest-only 6 \| unmapped 1/);
  assert.equal(r.stdout.split("\n").filter((l) => l.includes("REJECTED")).length, 2);
  assert.match(r.stdout, /Remaining in source: .*Fixable by fixes\.patch: 11\./);
  assert.match(r.stdout, /Outputs: .*report\.html .*fixes\.patch .*results\.sarif .*audit\.json/);
  const sarif = sarifLogSchema.parse(readJson(out, "results.sarif"));
  assert.equal(sarif.runs[0]!.results.length, 18);
  assert.equal(sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri, "fixtures/storefront/index.html");
  const audit = readJson<AuditResult & { schemaVersion: number }>(out, "audit.json");
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.config.sourceRoot, "fixtures/storefront");
  assert.match(readFileSync(join(out, "fixes.patch"), "utf8"), /--- a\/fixtures\/storefront\/index\.html/);
  // Stderr is JSON log lines only, one per line.
  for (const line of r.stderr.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), line);
});

test("[CLI-02] --fail-on serious exits 1 when a serious finding's fix was accepted but not written", (t) => {
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli([...storefrontArgs(out), "--fail-on", "serious"], { cwd: PROJECT_ROOT });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--fail-on serious: a violation at or above that level is still in the source files/);
  // The run still wrote everything, and 11 accepted fixes did not lower the exit code because none was written.
  assert.ok(existsSync(join(out, "results.sarif")));
  const audit = readJson<AuditResult>(out, "audit.json");
  assert.equal(audit.summary.accepted, 11);
  assert.equal(audit.written, null);
  // Without the flag the same run exits 0.
  assert.equal(spawnCli(storefrontArgs(tmpDir(t, "a11y-cli-")), { cwd: PROJECT_ROOT }).status, 0);
});

test("[CLI-02] --write --fail-on serious exits 1 because the accepted contrast-inline fix (design review) is not written and its finding remains in source", (t) => {
  const site = tmpDir(t, "a11y-cli-site-");
  cpSync(FIXTURE_ROOT, site, { recursive: true });
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli([...storefrontArgs(out, site), "--write", "--fail-on", "serious", "--repo-root", site], { cwd: PROJECT_ROOT });
  assert.equal(r.status, 1, r.stderr);
  const written = readFileSync(join(site, "index.html"), "utf8");
  assert.match(written, /<html lang="en"/);
  assert.ok(written.includes("<title>Orbit Outfitters</title>") && written.includes('id="email-2"'));
  assert.equal(written.includes("#767676"), false, "the contrast fix is a design decision and is not written");
  assert.equal(written.includes("aria-label="), false);
  assert.match(r.stdout, /Written: index\.html \(3 verified fixes; 8 fixes left in fixes\.patch, need human review\)\./);
  const audit = readJson<AuditResult>(out, "audit.json");
  assert.deepEqual(audit.written!.fixes.length, 3);
  assert.ok(audit.written!.remaining.some((f) => f.ruleId === "color-contrast" && f.status === "violation"), "the contrast finding remains in the source");
  assert.equal(audit.summary.remainingInSource, 16);
  // fixes.patch now holds only what was left and applies to the written file.
  const patch = readFileSync(join(out, "fixes.patch"), "utf8");
  assert.equal(patch.includes('lang="en"'), false);
  assert.ok(patch.includes("#767676"));
  // results.sarif lists what is in the files after the write: the written fixes are gone.
  const sarif = sarifLogSchema.parse(readJson(out, "results.sarif"));
  assert.equal(sarif.runs[0]!.results.length, 15);
  assert.equal(sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri, "index.html", "repo root is the site, so uris are relative to it");
  assert.equal(sarif.runs[0]!.results.filter((x) => x.properties.fixStatus === "accepted").length, 8);
});

test("[CLI-01] --json prints one JSON line whose fields equal the summary", (t) => {
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli([...storefrontArgs(out), "--json"], { cwd: PROJECT_ROOT });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]!);
  assert.deepEqual(summary, readJson<AuditResult>(out, "audit.json").summary);
  assert.equal(summary.accepted, 11);
  assert.equal(summary.violations, 15);
});

test("[AUD-05] A11Y_BROWSER_PATH pointing at a missing file exits 3 and the message names A11Y_BROWSER_PATH and npm run browser:install", (t) => {
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli(["--src", "fixtures/storefront", "--out", out], { cwd: PROJECT_ROOT, env: { A11Y_BROWSER_PATH: join(out, "no-such-chromium") } });
  assert.equal(r.status, 3, r.stderr);
  const message = r.stderr.split("\n").filter((l) => l.startsWith("NO_BROWSER: "))[0]!;
  assert.match(message, /A11Y_BROWSER_PATH/);
  assert.match(message, /npm run browser:install/);
  assert.match(message, /no-such-chromium/);
  assert.equal(r.stdout, "");
});

test("[CLI-01] a scripted LLM outage (--llm-fixture tests/fixtures/llm/unavailable.json, lenient) exits 5 and still writes the report with gate-rejected: llm-unavailable", (t) => {
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli([...storefrontArgs(out).filter((a) => a !== "--strict-fake"), "--llm-fixture", join(PROJECT_ROOT, "tests", "fixtures", "llm", "unavailable.json")], { cwd: PROJECT_ROOT });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /LLM_UNAVAILABLE: LLM provider unavailable after 2 attempts \((timeout|server_error)\); LLM strategies skipped/);
  const audit = readJson<AuditResult>(out, "audit.json");
  const reasons = audit.outcomes.filter((o) => o.status === "gate-rejected").map((o) => (o.status === "gate-rejected" ? o.reason : ""));
  assert.ok(reasons.length >= 6 && reasons.every((x) => x === "llm-unavailable"), reasons.join());
  assert.ok(audit.warnings.includes("llm-unavailable"));
  assert.match(readFileSync(join(out, "report.html"), "utf8"), /llm-unavailable/);
  assert.match(r.stdout, /gate-rejected \(llm-unavailable\)/);
  // The deterministic fixes were still verified and are in the patch.
  assert.equal(audit.summary.accepted, 4);
  assert.ok(existsSync(join(out, "fixes.patch")));
});

test("[LLM-10] --llm none exits 0 and every LLM strategy is suggest-only: llm-disabled", (t) => {
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli(["--src", "fixtures/storefront", "--lang", "en", "--llm", "none", "--recorded", AUDITS, "--out", out], { cwd: PROJECT_ROOT });
  assert.equal(r.status, 0, r.stderr);
  const audit = readJson<AuditResult>(out, "audit.json");
  assert.equal(audit.llm.provider, "none");
  assert.equal(audit.llm.calls, 0);
  const llm = audit.outcomes.filter((o) => o.status === "suggest-only" && o.plan.strategy.endsWith("-llm"));
  assert.equal(llm.length, 8, "link-name x2, label, button-name and image-alt x4");
  assert.ok(llm.every((o) => o.status === "suggest-only" && o.reason === "llm-disabled"));
  assert.equal(audit.outcomes.filter((o) => o.status === "accepted").length, 4);
  assert.match(r.stdout, /LLM: none/);
});

test("[CLI-05] spawned from a temp working directory outside the tool, on the uncovered site, the run exits 0 with no-scripted-answer suggestions, and every SARIF uri is relative to --repo-root", (t) => {
  const cwd = tmpDir(t, "a11y-cli-cwd-");
  cpSync(join(SITES_DIR, "uncovered"), join(cwd, "site"), { recursive: true });
  const r = spawnCli(["--src", "site", "--recorded", AUDITS, "--out", "out"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  const audit = readJson<AuditResult>(cwd, "out", "audit.json");
  const suggestions = audit.outcomes.filter((o) => o.status === "suggest-only");
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((o) => o.status === "suggest-only" && o.reason === "no-scripted-answer"));
  const sarif = sarifLogSchema.parse(readJson(cwd, "out", "results.sarif"));
  assert.equal(sarif.runs[0]!.results.length, 2);
  for (const result of sarif.runs[0]!.results) {
    assert.equal(result.locations[0]!.physicalLocation.artifactLocation.uri, "site/index.html");
    assert.equal(result.properties.uriOutsideRoot, undefined);
  }
  // With --repo-root pointing into the site, the uri is relative to it.
  const rooted = spawnCli(["--src", "site", "--recorded", AUDITS, "--out", "out2", "--repo-root", "site"], { cwd });
  assert.equal(rooted.status, 0, rooted.stderr);
  assert.equal(sarifLogSchema.parse(readJson(cwd, "out2", "results.sarif")).runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri, "index.html");
  // No fix at all, and still exit 0 (CS-10).
  assert.equal(audit.summary.accepted, 0);
  assert.equal(existsSync(join(cwd, "out", "fixes.patch")), false, "no fixes.patch without a fix (P-11)");
});

test("[CLI-04] with LLM_API_KEY set in the child env, the key appears in none of stdout, stderr, report.html, results.sarif or audit.json", (t) => {
  const key = "sk-or-v1-" + "z".repeat(40);
  const out = tmpDir(t, "a11y-cli-");
  // The real client against a closed loopback port: the key travels in a request header that fails to connect.
  const r = spawnCli(["--src", "fixtures/storefront", "--lang", "en", "--llm", "openai-compatible", "--recorded", AUDITS, "--out", out], {
    cwd: PROJECT_ROOT,
    env: { LLM_API_KEY: key, LLM_MODEL: "test-model", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_TIMEOUT_MS: "2000", LOG_LEVEL: "debug" },
  });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /"event":"provider_failure"/, "the client really tried to connect");
  const texts = { stdout: r.stdout, stderr: r.stderr, report: readFileSync(join(out, "report.html"), "utf8"), sarif: readFileSync(join(out, "results.sarif"), "utf8"), audit: readFileSync(join(out, "audit.json"), "utf8") };
  for (const [name, text] of Object.entries(texts)) {
    assert.equal(text.includes(key), false, `${name} contains the key`);
    assert.equal(text.includes("z".repeat(20)), false, `${name} contains part of the key`);
  }
  assert.match(texts.audit, /"apiKey": "\[REDACTED\]"/);
  // A usage error with a key in the environment also keeps it out.
  const bad = spawnCli(["--src", "fixtures/storefront", "--llm", "openai-compatible"], { cwd: PROJECT_ROOT, env: { LLM_API_KEY: key } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /LLM_MODEL/);
  assert.equal((bad.stdout + bad.stderr).includes(key), false);
});

test("[RF-2] --out inside --src: a second run gives the same summary, because the first report is never part of the audited tree", (t: TestContext) => {
  const site = tmpDir(t, "a11y-cli-site-");
  cpSync(FIXTURE_ROOT, site, { recursive: true });
  const out = join(site, "a11y-report");
  const first = spawnCli(storefrontArgs(out, site), { cwd: PROJECT_ROOT });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(out, "report.html")));
  const second = spawnCli(storefrontArgs(out, site), { cwd: PROJECT_ROOT });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(readJson<AuditResult>(out, "audit.json").summary.accepted, 11);
});

test("[RF-1] a clean site audited in a real browser exits 0, says \"No findings\", writes no fixes.patch and a SARIF with 0 results, even with --fail-on minor", (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const out = tmpDir(t, "a11y-cli-");
  const r = spawnCli(["--src", join(SITES_DIR, "clean"), "--fail-on", "minor", "--out", out, "--llm", "none"], { cwd: PROJECT_ROOT, env: { A11Y_BROWSER_PATH: exe } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No findings/);
  assert.match(r.stdout, /No fixes to apply/);
  assert.equal(existsSync(join(out, "fixes.patch")), false);
  assert.equal(sarifLogSchema.parse(readJson(out, "results.sarif")).runs[0]!.results.length, 0);
  assert.match(readFileSync(join(out, "report.html"), "utf8"), /No findings/);
  assert.deepEqual(readJson<AuditResult>(out, "audit.json").findings, []);
  assert.match(r.stdout, /audit: Chromium \(A11Y_BROWSER_PATH\)/);
});
