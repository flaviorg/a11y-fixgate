// writeOutputs (spec 5.8; OUT-01 to OUT-04, RF-1, P-11) over the recorded storefront run and an empty result.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sarifLogSchema } from "../../src/contracts/sarif.ts";
import { auditJsonSchema } from "../../src/contracts/result.ts";
import { writeOutputs } from "../../src/output/write-outputs.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";
import { emptyResult } from "../helpers/results.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = join(import.meta.dirname, "..", "..");

test("[OUT-01] [OUT-02] [OUT-03] [OUT-04] the storefront run writes report.html, fixes.patch, results.sarif and audit.json", async (t) => {
  const run = await runAuditRecorded("storefront");
  const outDir = tmpDir(t, "a11y-outputs-");
  const { written } = writeOutputs(run, { outDir: join(outDir, "nested", "report"), sourceRoot: run.config.sourceRoot, repoRoot: PROJECT, sarif: true });
  assert.deepEqual(written, ["report.html", "fixes.patch", "results.sarif", "audit.json"]);
  const dir = join(outDir, "nested", "report");
  assert.match(readFileSync(join(dir, "report.html"), "utf8"), /^<!doctype html>/);
  const patch = readFileSync(join(dir, "fixes.patch"), "utf8");
  assert.match(patch, /^=+\n--- a\/fixtures\/storefront\/index\.html\n\+\+\+ b\/fixtures\/storefront\/index\.html\n/);
  assert.equal(sarifLogSchema.safeParse(JSON.parse(readFileSync(join(dir, "results.sarif"), "utf8"))).success, true);
  assert.equal(auditJsonSchema.safeParse(JSON.parse(readFileSync(join(dir, "audit.json"), "utf8"))).success, true);
});

test("[RF-1] with zero included fixes no fixes.patch is written, and results.sarif is valid with 0 results", (t) => {
  const outDir = tmpDir(t, "a11y-outputs-");
  // A stale patch of an earlier run must not survive.
  writeFileSync(join(outDir, "fixes.patch"), "stale");
  const result = emptyResult();
  const { written } = writeOutputs(result, { outDir, sourceRoot: result.config.sourceRoot, repoRoot: "/work", sarif: true });
  assert.deepEqual(written, ["report.html", "results.sarif", "audit.json"]);
  assert.equal(existsSync(join(outDir, "fixes.patch")), false);
  const sarif = sarifLogSchema.parse(JSON.parse(readFileSync(join(outDir, "results.sarif"), "utf8")));
  assert.equal(sarif.runs[0]!.results.length, 0);
  assert.match(readFileSync(join(outDir, "report.html"), "utf8"), /No findings/);
});

test("[OUT-03] --no-sarif writes no results.sarif and removes a stale one", async (t) => {
  const run = await runAuditRecorded("storefront");
  const outDir = tmpDir(t, "a11y-outputs-");
  writeFileSync(join(outDir, "results.sarif"), "stale");
  const { written } = writeOutputs(run, { outDir, sourceRoot: run.config.sourceRoot, repoRoot: PROJECT, sarif: false });
  assert.deepEqual(written, ["report.html", "fixes.patch", "audit.json"]);
  assert.equal(existsSync(join(outDir, "results.sarif")), false);
});

test("[VER-05] a combined-audit mismatch writes fixes.rejected.patch, never fixes.patch", async (t) => {
  const run = structuredClone(await runAuditRecorded("storefront"));
  run.warnings.push("combined-audit-mismatch:0123456789abcdef");
  const outDir = tmpDir(t, "a11y-outputs-");
  writeFileSync(join(outDir, "fixes.patch"), "stale");
  const { written } = writeOutputs(run, { outDir, sourceRoot: run.config.sourceRoot, repoRoot: PROJECT, sarif: true });
  assert.deepEqual(written, ["report.html", "fixes.rejected.patch", "results.sarif", "audit.json"]);
  assert.equal(existsSync(join(outDir, "fixes.patch")), false);
});
