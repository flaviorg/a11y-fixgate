// --write and fixes.patch in a real Chromium on temporary copies of the storefront (plan Task 31; OUT-02, OUT-05).
// Needs a browser (tests/helpers/browser.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { createLlmStrategyRunner } from "../../src/app/llm-strategies.ts";
import { CombinedMismatchError, writeVerifiedFixes } from "../../src/app/run-audit.ts";
import type { AuditRun, RunAuditDeps } from "../../src/app/run-audit.ts";
import { createPlaywrightRunner } from "../../src/browser/playwright-runner.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { AppError } from "../../src/domain/errors.ts";
import { analyzeSnapshot } from "../../src/domain/findings.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { systemClock } from "../../src/infra/clock.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { existsInsideRoot, readInsideRoot } from "../../src/infra/safe-read.ts";
import { scratchFactory } from "../../src/infra/scratch.ts";
import { staticServerFactory } from "../../src/infra/static-server.ts";
import { treeSha256 } from "../../src/infra/tree-hash.ts";
import { createFakeProvider } from "../../src/llm/fake-provider.ts";
import { fixesPatchText } from "../../src/output/patch-file.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { FIXTURE_ROOT, readFixture, runAuditOnFixtureCopy } from "../helpers/fixtures.ts";
import { htmlFilesOf } from "../helpers/scripted-runner.ts";
import { serveCopy } from "../helpers/serve.ts";
import { tmpDir } from "../helpers/tmp.ts";

const quiet = createLogger({ component: "runner", level: "error", write: () => {} });

/** The demo run (strict fake, lang en) with --write on a temporary copy. */
function writeRun(t: TestContext, exe: string, write: boolean): Promise<AuditRun & { root: string; out: string }> {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, "..", "llm", "storefront.json"), "utf8"));
  return runAuditOnFixtureCopy(t, exe, {
    write,
    llm: (root) => createLlmStrategyRunner({ provider: createFakeProvider({ fixture, strict: true }), sourceRoot: root, pagePath: "/", logger: quiet }),
  });
}

function filesUnder(root: string, dir = ""): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(root, join(dir, e.name)) : [join(dir, e.name)])).sort();
}

test('[OUT-05] --write on a temp copy writes lang="en", <title>Orbit Outfitters</title> and id="email-2", and no aria-label=, no alt=" and no #767676', async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const original = readFixture("index.html");
  for (const absent of ["aria-label=", 'alt="', "#767676", "<title>", 'lang="']) assert.equal(original.includes(absent), false, `the fixture has no ${absent}`);
  const run = await writeRun(t, exe, true);
  const onDisk = readFileSync(join(run.root, "index.html"), "utf8");
  assert.match(onDisk, /<html lang="en"/);
  assert.ok(onDisk.includes("<title>Orbit Outfitters</title>"));
  assert.ok(onDisk.includes('id="email-2"') && onDisk.includes('for="email-2"'));
  for (const absent of ["aria-label=", 'alt="', "#767676"]) assert.equal(onDisk.includes(absent), false, `${absent} is a needs-review fix and is never written`);
  assert.deepEqual(run.written!.files, ["index.html"]);
  assert.equal(run.written!.fixes.length, 3);
  assert.equal(run.writeSubsetAudited, true);
  // 11 accepted, 3 written; the 8 others are the LLM and design-review fixes that stay in fixes.patch.
  assert.equal(run.summary.accepted, 11);
  assert.equal(run.summary.fixableByPatch, 8);
  assert.ok(run.warnings.some((w) => w.startsWith("left-in-patch:")));
});

test("[OUT-05] the written file equals the audited subset tree, a re-audit finds none of the written fingerprints, and untouched files are byte-identical", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const run = await writeRun(t, exe, true);
  assert.equal(readFileSync(join(run.root, "index.html"), "utf8"), run.writtenFiles["index.html"]);

  // Every file but index.html is byte-identical to the bundled fixture.
  const names = filesUnder(FIXTURE_ROOT);
  assert.deepEqual(filesUnder(run.root), names);
  for (const rel of names.filter((n) => n !== "index.html")) assert.deepEqual(readFileSync(join(run.root, rel)), readFileSync(join(FIXTURE_ROOT, rel)), rel);

  // An independent audit of the written tree.
  const served = await serveCopy(run.root);
  const runner = createPlaywrightRunner({ executablePath: exe, outDir: null, logger: quiet });
  try {
    const snapshot = await runner.audit(served.target(), DEFAULT_PROFILE);
    const files = htmlFilesOf(served.root);
    const again = analyzeSnapshot(snapshot, buildHtmlIndex(files), "index.html", DEFAULT_PROFILE);
    const writtenFingerprints = new Set(run.findings.filter((f) => run.written!.fixes.includes(f.id)).map((f) => f.fingerprint));
    assert.equal(writtenFingerprints.size, 3);
    for (const f of again) assert.equal(writtenFingerprints.has(f.fingerprint), false, `${f.id} was written but is still found`);
    // The post-write state the run reports is that audit.
    assert.deepEqual(again.map((f) => f.fingerprint).sort(), run.written!.remaining.map((f) => f.fingerprint).sort());
    assert.equal(again.length, 16);
    assert.equal(run.summary.remainingInSource, 16);
  } finally {
    await runner.close();
    await served.close();
  }
});

function depsFor(runner: ReturnType<typeof createPlaywrightRunner>): RunAuditDeps {
  return {
    runner,
    llm: null,
    servers: staticServerFactory,
    clock: systemClock,
    logger: quiet,
    scratch: scratchFactory,
    readPage: (root, rel) => readInsideRoot(root, rel).toString("utf8"),
    exists: existsInsideRoot,
  };
}

test("[OUT-05] a symlinked target file is refused with UNSAFE_PATH and nothing is written", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const run = await runAuditOnFixtureCopy(t, exe, { llm: null, write: false });
  assert.ok(run.combined && run.combined.included.length >= 3);
  // Between the audit and the write the page is replaced by a symbolic link to a file outside the root.
  const outside = join(tmpDir(t, "a11y-outside-"), "target.html");
  writeFileSync(outside, "<p>outside the source root</p>");
  rmSync(join(run.root, "index.html"));
  symlinkSync(outside, join(run.root, "index.html"));
  const runner = createPlaywrightRunner({ executablePath: exe, outDir: null, logger: quiet });
  try {
    await assert.rejects(writeVerifiedFixes(run, { ...run.config, write: true }, depsFor(runner)), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "UNSAFE_PATH");
      assert.match(err.message, /^Refused to read or write index\.html: outside the source root or a symbolic link$/);
      assert.equal(err instanceof CombinedMismatchError, false);
      return true;
    });
  } finally {
    await runner.close();
  }
  assert.equal(readFileSync(outside, "utf8"), "<p>outside the source root</p>", "nothing was written through the link");
});

function gitOnPath(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  return probe.error === undefined && probe.status === 0;
}

test("[OUT-02] fixes.patch passes git apply --check run from a temp repository root", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  if (!gitOnPath()) return void t.skip("git is not on PATH");
  const run = await runAuditOnFixtureCopy(t, exe, { llm: null, write: false });
  // A temporary repository root: the site lives in a sub-directory, as with --src public. No git init: git apply works outside a repository.
  const repo = tmpDir(t, "a11y-repo-");
  const site = join(repo, "site", "public");
  mkdirSync(dirname(site), { recursive: true });
  cpSync(FIXTURE_ROOT, site, { recursive: true });
  const patch = fixesPatchText(run, site, repo);
  assert.ok(patch !== null && patch.includes("--- a/site/public/index.html"));
  writeFileSync(join(repo, "fixes.patch"), patch);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CEILING_DIRECTORIES: dirname(repo) };
  const check = spawnSync("git", ["apply", "--check", "fixes.patch"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  // The check is meaningful: a changed file no longer matches.
  writeFileSync(join(site, "index.html"), readFileSync(join(site, "index.html"), "utf8").replace("<html", "<html class='x'"));
  const stale = spawnSync("git", ["apply", "--check", "fixes.patch"], { cwd: repo, env, encoding: "utf8" });
  assert.notEqual(stale.status, 0);
  // And applying the patch for real equals the combined content.
  cpSync(FIXTURE_ROOT, site, { recursive: true });
  const applied = spawnSync("git", ["apply", "fixes.patch"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(site, "index.html"), "utf8"), run.combinedFiles["index.html"]);
  assert.equal(treeSha256(site) === treeSha256(FIXTURE_ROOT), false);
});
