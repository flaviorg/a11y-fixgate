// results.sarif (spec 5.8.1; OUT-03, RF-1) over the recorded storefront run and small synthetic results.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isUnmapped } from "../../src/contracts/finding.ts";
import type { Finding } from "../../src/contracts/finding.ts";
import { sarifLogSchema } from "../../src/contracts/sarif.ts";
import type { AuditResult } from "../../src/contracts/result.ts";
import { remainingFindings } from "../../src/domain/findings.ts";
import { toSarif } from "../../src/output/sarif.ts";
import { emptyResult } from "../helpers/results.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";

const PROJECT = join(import.meta.dirname, "..", "..");
let cached: Promise<AuditResult> | null = null;
const storefront = (): Promise<AuditResult> => (cached ??= runAuditRecorded("storefront"));
const opts = (result: AuditResult) => ({ sourceRoot: result.config.sourceRoot, repoRoot: PROJECT });

test("[OUT-03] with src \"public\" under the repo root, every uri is \"public/index.html\"", async () => {
  const result = await storefront();
  const sarif = toSarif(result, { sourceRoot: "/repo/public", repoRoot: "/repo" });
  const uris = new Set(sarif.runs[0]!.results.map((r) => r.locations[0]!.physicalLocation.artifactLocation.uri));
  assert.deepEqual([...uris], ["public/index.html"]);
  assert.equal(sarif.runs[0]!.results.every((r) => r.properties.uriOutsideRoot === undefined), true);
  assert.equal(sarif.runs[0]!.properties.repoRoot, "repo", "only the directory name, never an absolute path");
});

test("[OUT-03] a file outside the repo root gets a uri relative to --src and uriOutsideRoot", async () => {
  const result = await storefront();
  const sarif = toSarif(result, { sourceRoot: "/elsewhere/site", repoRoot: "/repo" });
  for (const r of sarif.runs[0]!.results) {
    assert.equal(r.locations[0]!.physicalLocation.artifactLocation.uri, "index.html");
    assert.equal(r.properties.uriOutsideRoot, true);
  }
});

test("[OUT-03] the storefront SARIF has 18 results, 11 with fixStatus \"accepted\", every incomplete as note, unreachable-control as warning, 1-based regions and partialFingerprints", async () => {
  const result = await storefront();
  const sarif = toSarif(result, opts(result));
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs.length, 1);
  const run = sarif.runs[0]!;
  assert.equal(run.results.length, 18);
  assert.equal(run.results.filter((r) => r.properties.fixStatus === "accepted").length, 11);
  assert.equal(run.properties.unmappedCount, 1);
  assert.equal(run.properties.keyboardFindings, 3);
  assert.equal(run.properties.axeVersion, "4.14.0");
  for (const r of run.results) {
    const loc = r.locations[0]!.physicalLocation;
    assert.ok(loc.region.startLine >= 1 && loc.region.startColumn >= 1 && loc.region.endLine >= loc.region.startLine && loc.region.endColumn >= 1);
    assert.match(r.partialFingerprints["a11yFixgate/v1"], /^[0-9a-f]{16}$/);
    assert.equal(loc.artifactLocation.uri, "fixtures/storefront/index.html");
    assert.equal(loc.artifactLocation.uriBaseId, "%SRCROOT%");
  }
  const byRule = (id: string) => run.results.filter((r) => r.ruleId === id);
  assert.ok(byRule("color-contrast").some((r) => r.properties.status === "incomplete" && r.level === "note"));
  assert.ok(run.results.filter((r) => r.properties.status === "incomplete").every((r) => r.level === "note"));
  assert.equal(byRule("unreachable-control").length, 1);
  assert.equal(byRule("unreachable-control")[0]!.level, "warning");
  assert.equal(byRule("keyboard-trap")[0]!.level, "note");
  assert.equal(byRule("image-alt")[0]!.level, "error");
  assert.ok(byRule("target-size").every((r) => r.level === "error")); // serious
  // The message of an accepted finding ends with the fixes.patch note; verified and needs-review differ.
  const lang = byRule("html-has-lang")[0]!;
  assert.equal(lang.properties.fixStatus, "accepted");
  assert.equal(lang.properties.verified, "verified");
  assert.equal(lang.properties.needsHumanReview, false);
  assert.ok(lang.message.text.endsWith("fixes.patch resolves this (verified in a browser)"), lang.message.text);
  const alt = byRule("image-alt").find((r) => r.properties.fixStatus === "accepted")!;
  assert.equal(alt.properties.verified, "verified-present-needs-review");
  assert.equal(alt.properties.needsHumanReview, true);
  assert.ok(alt.message.text.endsWith("fixes.patch resolves this (needs human review)"), alt.message.text);
  // Other fix statuses.
  assert.ok(run.results.some((r) => r.properties.fixStatus === "suggest-only" && r.ruleId === "target-size"));
  assert.ok(run.results.some((r) => r.properties.fixStatus === "suggest-only" && r.ruleId === "keyboard-trap"));
  assert.ok(run.results.some((r) => r.properties.fixStatus === "none" && r.ruleId === "color-contrast" && r.properties.status === "incomplete"));
  assert.ok(sarifLogSchema.safeParse(sarif).success);
  assert.ok(run.tool.driver.rules.length >= 10);
  assert.ok(run.tool.driver.rules.every((r) => r.properties.tags.length <= 10 && r.properties.tags.includes("accessibility")));
});

test("[OUT-03] SARIF caps at 1,000 results with properties.truncated and at most 10 tags per rule, and validates against the subset schema", async () => {
  const result = structuredClone(await storefront());
  const mapped = result.findings.find((f) => !isUnmapped(f.location))!;
  const many: Finding[] = [];
  for (let i = 0; i < 1100; i++) many.push({ ...structuredClone(mapped), id: `image-alt-${i + 1}`, fingerprint: i.toString(16).padStart(16, "0") as Finding["fingerprint"], wcag: Array.from({ length: 15 }, (_, k) => `1.${k}.1`) });
  result.findings = many;
  result.outcomes = [];
  result.combined = null;
  const sarif = toSarif(result, opts(result));
  const run = sarif.runs[0]!;
  assert.equal(run.results.length, 1000);
  assert.equal(run.properties.truncated, true);
  assert.ok(run.tool.driver.rules.every((r) => r.properties.tags.length <= 10));
  assert.ok(sarifLogSchema.safeParse(sarif).success);
  // Without the cap there is no truncated flag.
  const small = toSarif(await storefront(), opts(await storefront()));
  assert.equal("truncated" in small.runs[0]!.properties, false);
});

test("[OUT-03] after a write, written fixes are absent from the results", async () => {
  const result = structuredClone(await storefront());
  const writtenIds = result.outcomes.filter((o) => o.status === "accepted" && o.verified === "verified").map((o) => (o.status === "accepted" ? o.candidate.findingId : ""));
  assert.equal(writtenIds.length, 3);
  const writtenFingerprints = new Set(result.findings.filter((f) => writtenIds.includes(f.id)).map((f) => f.fingerprint));
  result.written = { files: ["index.html"], fixes: writtenIds, remaining: result.findings.filter((f) => !writtenFingerprints.has(f.fingerprint)) };
  assert.equal(remainingFindings(result).length, 16);
  const sarif = toSarif(result, opts(result));
  const run = sarif.runs[0]!;
  assert.equal(run.results.length, 15);
  const present = new Set(run.results.map((r) => r.partialFingerprints["a11yFixgate/v1"]));
  for (const fp of writtenFingerprints) assert.equal(present.has(fp), false);
  // The unwritten accepted fixes are still open alerts that fixes.patch resolves.
  assert.equal(run.results.filter((r) => r.properties.fixStatus === "accepted").length, 8);
});

test("[RF-1] a clean page gives a valid SARIF log with 0 results", () => {
  const result = emptyResult();
  const sarif = toSarif(result, { sourceRoot: result.config.sourceRoot, repoRoot: "/work" });
  assert.equal(sarif.runs[0]!.results.length, 0);
  assert.deepEqual(sarif.runs[0]!.tool.driver.rules, []);
  assert.ok(sarifLogSchema.safeParse(sarif).success);
});
