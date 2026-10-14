import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditConfigSchema, ENV_KEYS } from "../../src/contracts/config.ts";
import { findingSchema, fingerprintSchema, isUnmapped } from "../../src/contracts/finding.ts";
import type { Finding, SourceLocation, Unmapped } from "../../src/contracts/finding.ts";
import { fixOutcomeSchema, gateRejectReasonSchema, verdictSchema } from "../../src/contracts/fix.ts";
import { altTextInput, altTextOutput, controlNameInput, controlNameOutput } from "../../src/contracts/llm.ts";
import { auditResultSchema, summarySchema } from "../../src/contracts/result.ts";
import { sarifLogSchema } from "../../src/contracts/sarif.ts";
import { auditSnapshotSchema, axeRawResultSchema, DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { TOOL } from "../../src/contracts/tool.ts";
import { llmFixtureSchema } from "../../src/llm/fixture-format.ts";
import { axeResult, makeSnapshot } from "../helpers/snapshots.ts";
import { loadRecordings } from "../helpers/recorded.ts";
import { installedAxe } from "../../src/browser/axe-config.ts";

const base = { sourceRoot: "/s", browser: { executablePath: null, source: "env" }, llm: { provider: "none" } };

const node = {
  selector: '["img"]', tag: "img", attrs: { src: "a.png" }, text: "", domTagIndex: 0, domTagCount: 1,
  htmlSnippet: '<img src="a.png">', rect: { x: 0, y: 0, width: 10, height: 10 }, dataSource: null,
};
const location: SourceLocation = {
  file: "index.html", startOffset: 0, endOffset: 10, startTag: { startOffset: 0, endOffset: 10 }, attrs: { src: { startOffset: 5, endOffset: 9 } },
  startLine: 1, startCol: 1, endLine: 1, endCol: 11, tagOrdinal: 0, method: "ordinal",
};
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "image-alt-1", source: "axe", ruleId: "image-alt", status: "violation", impact: "critical", wcag: ["1.1.1"], level: "A",
  help: "Images must have alternative text", helpUrl: "https://example.test/help", message: "Fix any of the following", node, location,
  fingerprint: "0123456789abcdef" as Finding["fingerprint"], data: {}, ...over,
});

test("[LLM-06] config accepts https and http on loopback, rejects http to a remote host, javascript: and file:", () => {
  const llm = (baseUrl: string) => auditConfigSchema.safeParse({ ...base, llm: { provider: "openai-compatible", baseUrl, model: "m", apiKey: "k".repeat(8), timeoutMs: 30000 } }).success;
  assert.deepEqual(["https://openrouter.ai/api/v1", "http://127.0.0.1:1234/v1", "http://example.com/v1", "javascript:alert(1)", "file:///etc/passwd"].map(llm), [true, true, false, false, false]);
});

test("[LLM-06] config also accepts http on localhost and [::1] and rejects look-alike hosts", () => {
  const llm = (baseUrl: string) => auditConfigSchema.safeParse({ ...base, llm: { provider: "openai-compatible", baseUrl, model: "m", apiKey: "k".repeat(8), timeoutMs: 30000 } }).success;
  assert.deepEqual(["http://localhost:8080/v1", "http://[::1]:8080/v1", "http://localhost.evil.test/v1", "http://127.0.0.1.evil.test/v1"].map(llm), [true, true, false, false]);
});

test("[LLM-06] config rejects a short api key and an out-of-range timeout", () => {
  const llm = (over: object) => auditConfigSchema.safeParse({ ...base, llm: { provider: "openai-compatible", baseUrl: "https://a.test/v1", model: "m", apiKey: "k".repeat(8), timeoutMs: 30000, ...over } }).success;
  assert.deepEqual([llm({}), llm({ apiKey: "short" }), llm({ timeoutMs: 999 }), llm({ timeoutMs: 120001 })], [true, false, false, false]);
});

test("[CS-10] config defaults match spec 5.2", () => {
  const c = auditConfigSchema.parse(base);
  assert.deepEqual([c.pagePath, c.out, c.maxFixes, c.maxCandidates, c.maxLlmCalls, c.deadlineMs, c.failOn, c.lang, c.write, c.allowNewIncomplete], ["/", "reports/latest", 25, 60, 40, 600_000, "none", null, false, false]);
  assert.deepEqual([c.fix, c.sarif, c.repoRoot], [true, true, null]);
});

test("[CS-10] config is strict and checks numeric bounds and the page path", () => {
  const ok = (over: object) => auditConfigSchema.safeParse({ ...base, ...over }).success;
  assert.deepEqual(
    [ok({}), ok({ extra: 1 }), ok({ maxFixes: 101 }), ok({ maxCandidates: 0 }), ok({ maxCandidates: 301 }), ok({ maxLlmCalls: 201 }), ok({ deadlineMs: 9_999 }), ok({ pagePath: "/about/" }), ok({ pagePath: "about" }), ok({ pagePath: "/a b" }), ok({ failOn: "high" })],
    [true, false, false, false, false, false, false, true, false, false, false],
  );
});

test("[CS-10] the fake provider defaults to the bundled fixture (null) and lenient mode", () => {
  const c = auditConfigSchema.parse({ ...base, llm: { provider: "fake" } });
  assert.deepEqual(c.llm, { provider: "fake", fixture: null, strict: false });
});

test("[REP-02] ENV_KEYS lists the 12 variables of spec 5.11 in order", () => {
  assert.deepEqual([...ENV_KEYS], ["LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT_MS", "LLM_REQUEST_OVERRIDES", "A11Y_REPO_ROOT", "A11Y_BROWSER_PATH", "REQUIRE_BROWSER", "CI", "LOG_LEVEL", "A11Y_OUT"]);
});

test("[FIX-02] lang accepts en, pt-BR and zh-Hant-TW and rejects EN and e", () => {
  const lang = (l: string) => auditConfigSchema.safeParse({ ...base, lang: l }).success;
  assert.deepEqual(["en", "pt-BR", "zh-Hant-TW", "EN", "e"].map(lang), [true, true, true, false, false]);
});

test("[AUD-07] snapshot schema is strict and keeps violations and incomplete apart; raw axe results pass unknown fields through", () => {
  const snap = makeSnapshot({ axe: { violations: [axeResult({ id: "image-alt" })], incomplete: [axeResult({ id: "color-contrast" })], passesCount: 3, inapplicableCount: 4, toolOptions: { runOnly: {} } } });
  const parsed = auditSnapshotSchema.parse(snap);
  assert.equal(parsed.axe.violations[0]?.id, "image-alt");
  assert.equal(parsed.axe.incomplete[0]?.id, "color-contrast");
  assert.equal(auditSnapshotSchema.safeParse({ ...snap, extra: 1 }).success, false, "extra top-level key fails");
  assert.equal(auditSnapshotSchema.safeParse({ ...snap, schemaVersion: 2 }).success, false);
  const withExtra = { ...axeResult({ id: "image-alt" }), newAxeField: { a: 1 } };
  const raw = axeRawResultSchema.parse(withExtra) as Record<string, unknown>;
  assert.deepEqual(raw["newAxeField"], { a: 1 });
  const nodeExtra = axeResult({ id: "x", nodes: [{ target: [["#host", "button"]], html: "<button>", any: [], all: [], none: [], ancestry: ["html"] } as never] });
  assert.equal(axeRawResultSchema.safeParse(nodeExtra).success, true, "shadow targets and extra node fields parse");
  assert.equal(auditSnapshotSchema.safeParse({ ...snap, ariaByNode: { "img[0]": 1 } }).success, false);
});

test("[CS-10] the default audit profile is the six tags, 200 tabs, 3 repeats and a 1280x800 viewport", () => {
  assert.deepEqual(DEFAULT_PROFILE.axeTags, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]);
  assert.deepEqual(DEFAULT_PROFILE.keyboard, { maxTabs: 200, trapRepeats: 3 });
  assert.deepEqual(DEFAULT_PROFILE.viewport, { width: 1280, height: 800 });
});

test("[LLM-07] LLM fixture responses need exactly one of output or error", () => {
  const key = "a".repeat(64);
  const fixture = (response: object) => ({ schemaVersion: 1, scenario: "t", promptHashes: { "alt-text.v1": "sha256:" + "b".repeat(64) }, responses: [{ key, task: "alt-text", label: "l", input: {}, ...response }] });
  const ok = (r: object) => llmFixtureSchema.safeParse(fixture(r)).success;
  assert.deepEqual(
    [ok({ output: { kind: "informative", alt: "x", reason: "y" }, error: "timeout" }), ok({}), ok({ output: { kind: "informative", alt: "x", reason: "y" } }), ok({ error: "timeout" }), ok({ error: "boom" })],
    [false, false, true, true, false],
  );
  assert.equal(llmFixtureSchema.parse(fixture({ error: "server_error" })).responses[0]?.attempt, 1, "attempt defaults to 1");
  assert.equal(llmFixtureSchema.safeParse({ ...fixture({ error: "timeout" }), extra: 1 }).success, false);
});

test("[LLM-02] LLM task inputs and outputs are strict and bounded", () => {
  const input = { pageTitle: "t", src: "a.png", surroundingText: "x", insideControl: false, image: null };
  assert.equal(altTextInput.safeParse(input).success, true);
  assert.equal(altTextInput.safeParse({ ...input, surroundingText: "x".repeat(601) }).success, false);
  assert.equal(altTextInput.safeParse({ ...input, image: { mime: "image/svg+xml", bytesBase64: "", sha256: "a".repeat(64), bytes: 1 } }).success, false);
  assert.equal(altTextOutput.safeParse({ kind: "informative", alt: "x", reason: "r" }).success, true);
  assert.equal(altTextOutput.safeParse({ kind: "other", alt: "x", reason: "r" }).success, false);
  assert.equal(altTextOutput.safeParse({ kind: "informative", alt: "x", reason: "r", extra: 1 }).success, false);
  const ctl = { role: "link", html: "<a>", surroundingText: "", href: "/x", placeholder: null, iconHints: [], pageTitle: "t" };
  assert.equal(controlNameInput.safeParse(ctl).success, true);
  assert.equal(controlNameInput.safeParse({ ...ctl, role: "div" }).success, false);
  assert.equal(controlNameInput.safeParse({ ...ctl, iconHints: new Array(11).fill("a") }).success, false);
  assert.equal(controlNameOutput.safeParse({ name: "Home", reason: "r" }).success, true);
  assert.equal(controlNameOutput.safeParse({ name: "n".repeat(201), reason: "r" }).success, false);
});

test("[VER-01] fingerprints are 16 lower-case hex characters", () => {
  assert.deepEqual(["0123456789abcdef", "0123456789ABCDEF", "abc", "0123456789abcdeg"].map((f) => fingerprintSchema.safeParse(f).success), [true, false, false, false]);
});

test("[MAP-05] findings are strict, have filename-safe ids and isUnmapped tells the location variants apart", () => {
  assert.equal(findingSchema.safeParse(finding()).success, true);
  const unmapped: Unmapped = { reason: "dom-only" };
  const f = findingSchema.parse(finding({ location: unmapped }));
  assert.equal(isUnmapped(f.location), true);
  assert.equal(isUnmapped(finding().location), false);
  assert.equal(findingSchema.safeParse(finding({ id: "image-alt#1" })).success, false);
  assert.equal(findingSchema.safeParse(finding({ id: "Image_Alt" })).success, false);
  assert.equal(findingSchema.safeParse({ ...finding(), extra: 1 }).success, false);
  assert.equal(findingSchema.safeParse(finding({ location: { reason: "closest" } as never })).success, false);
  assert.equal(findingSchema.safeParse(finding({ fingerprint: "nothex" as never })).success, false);
});

test("[P-15] verdicts and outcomes are discriminated unions; a rejected outcome carries newFindings", () => {
  assert.equal(verdictSchema.safeParse({ status: "accepted", targetGone: true, warnings: [] }).success, true);
  assert.equal(verdictSchema.safeParse({ status: "accepted", targetGone: false, warnings: [] }).success, false);
  const rejected = { status: "rejected", reasons: ["new-violation"], targetGone: true, newViolations: ["0123456789abcdef"], newIncomplete: [] };
  assert.equal(verdictSchema.safeParse(rejected).success, true);
  assert.equal(verdictSchema.safeParse({ ...rejected, reasons: ["made-up"] }).success, false);
  const candidate = { findingId: "link-name-2", fingerprint: "0123456789abcdef", plan: { strategy: "aria-label-llm", kind: "llm", edits: [], summary: "s", needsHumanReview: true, reviewReason: "llm-text", generatedIds: [] }, patch: "", patchedFiles: {}, patchSha256: "" };
  const outcome = { status: "rejected", candidate, verdict: rejected, afterSnapshotSha: "x" };
  assert.equal(fixOutcomeSchema.safeParse(outcome).success, false, "newFindings is required");
  assert.equal(fixOutcomeSchema.safeParse({ ...outcome, newFindings: [{ fingerprint: "0123456789abcdef", ruleId: "label-content-name-mismatch", anchor: "src:index.html#a[2]" }] }).success, true);
  assert.equal(fixOutcomeSchema.safeParse({ status: "skipped", findingId: "a-1", reason: "deadline" }).success, true);
  assert.equal(fixOutcomeSchema.safeParse({ status: "skipped", findingId: "a-1", reason: "bored" }).success, false);
  assert.equal(fixOutcomeSchema.safeParse({ status: "conflict", findingId: "a-1", with: "b-1", reason: "overlap" }).success, true);
  assert.equal(fixOutcomeSchema.safeParse({ status: "gate-rejected", findingId: "a-1", strategy: "alt-text-llm", reason: "alt-is-filename", proposal: { alt: "x.png" } }).success, true);
  assert.equal(fixOutcomeSchema.safeParse({ status: "gate-rejected", findingId: "a-1", strategy: "alt-text-llm", reason: "vibes", proposal: null }).success, false);
  assert.equal(gateRejectReasonSchema.safeParse("patch-out-of-bounds").success, true);
});

test("[P-5] the summary has exactly the 14 counters of spec 5.1", () => {
  assert.deepEqual(Object.keys(summarySchema.shape).sort(), [
    "accepted", "conflicts", "fixableByPatch", "gateRejected", "incomplete", "keyboard", "rejected", "remainingInSource", "skipped", "suggestOnly", "unmapped", "verified", "verifiedNeedsReview", "violations",
  ]);
});

test("[OUT-04] an empty audit result round-trips through auditResultSchema (RF-1 shape)", () => {
  const summary = Object.fromEntries(Object.keys(summarySchema.shape).map((k) => [k, 0]));
  const result = {
    config: auditConfigSchema.parse(base), baseline: makeSnapshot(), findings: [], outcomes: [], combined: null, summary,
    timings: { baselineMs: 1, loopMs: 0, combinedMs: 0, totalMs: 1 }, limits: { candidatesUsed: 0, llmCallsUsed: 0, deadlineHit: false },
    llm: { provider: "none", calls: 0, promptVersion: "v1" }, warnings: [], written: null,
  };
  assert.deepEqual(auditResultSchema.parse(result), result);
  assert.equal(auditResultSchema.safeParse({ ...result, summary: { ...summary, extra: 1 } }).success, false);
});

test("[OUT-03] the SARIF subset requires the fields GitHub requires and allows exactly one run", () => {
  const result = {
    ruleId: "image-alt", level: "error", message: { text: "Images must have alternative text" },
    locations: [{ physicalLocation: { artifactLocation: { uri: "public/index.html", uriBaseId: "%SRCROOT%" }, region: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 20 } } }],
    partialFingerprints: { "a11yFixgate/v1": "0123456789abcdef" },
    properties: { impact: "critical", status: "violation", wcag: ["1.1.1"], fixStatus: "none", verified: null, strategy: null, needsHumanReview: false },
  };
  const run = {
    tool: { driver: { name: TOOL.name, version: TOOL.version, informationUri: TOOL.informationUri, rules: [{ id: "image-alt", name: "image-alt", shortDescription: { text: "Images" }, helpUri: "https://example.test", properties: { tags: ["accessibility", "wcag2.2", "1.1.1"] } }] } },
    results: [result], properties: { unmappedCount: 1, keyboardFindings: 0, axeVersion: "4.14.0", repoRoot: "/repo" },
  };
  const log = { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [run] };
  assert.equal(sarifLogSchema.safeParse(log).success, true);
  assert.equal(sarifLogSchema.safeParse({ ...log, runs: [run, run] }).success, false, "one run only");
  assert.equal(sarifLogSchema.safeParse({ ...log, runs: [{ ...run, results: [] }] }).success, true, "zero results is valid (RF-1)");
  const noFp = { ...result, partialFingerprints: {} };
  assert.equal(sarifLogSchema.safeParse({ ...log, runs: [{ ...run, results: [noFp] }] }).success, false);
  const noLoc = { ...result, locations: [] };
  assert.equal(sarifLogSchema.safeParse({ ...log, runs: [{ ...run, results: [noLoc] }] }).success, false);
  const badRegion = { ...result, locations: [{ physicalLocation: { artifactLocation: { uri: "a.html", uriBaseId: "%SRCROOT%" }, region: { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 } } }] };
  assert.equal(sarifLogSchema.safeParse({ ...log, runs: [{ ...run, results: [badRegion] }] }).success, false);
  const tooManyTags = { ...run.tool.driver.rules[0], properties: { tags: new Array(11).fill("t") } };
  assert.equal(sarifLogSchema.safeParse({ ...log, runs: [{ ...run, tool: { driver: { ...run.tool.driver, rules: [tooManyTags] } } }] }).success, false);
});

test("[P-6] TOOL carries the name, the version and the information URI", () => {
  assert.deepEqual({ ...TOOL }, { name: "a11y-fixgate", version: "0.1.0", informationUri: "https://github.com/flaviorg/a11y-fixgate" });
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, TOOL.name);
});

test("[AUD-06] every recording validates against the strict snapshot schema and carries the installed axe version", () => {
  const recordings = loadRecordings();
  assert.ok(recordings.length >= 1, "at least the storefront baseline is recorded");
  for (const rec of recordings) {
    assert.ok(auditSnapshotSchema.safeParse(rec.snapshot).success, rec.file);
    assert.equal(rec.snapshot.axeVersion, installedAxe().version, rec.file);
    assert.match(rec.file, new RegExp(`^[a-z0-9-]+\\.${rec.recordingKey.slice(0, 12)}\\.json$`));
  }
});

test("[AUD-08] every recording carries domIds", () => {
  for (const rec of loadRecordings()) {
    assert.ok(Array.isArray(rec.snapshot.domIds) && rec.snapshot.domIds.length > 0, rec.file);
    assert.deepEqual(rec.snapshot.domIds, [...rec.snapshot.domIds].sort(), rec.file);
    assert.ok(Object.keys(rec.snapshot.ariaByNode).length > 0, rec.file);
  }
});

test("[LLM-07] fixtures/llm/storefront.json and tests/fixtures/llm/*.json validate and their promptHashes are current", async () => {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { llmKey, promptHash } = await import("../../src/llm/fixture-format.ts");
  const { PROMPTS } = await import("../../src/llm/prompts/index.ts");
  const project = join(import.meta.dirname, "..", "..");
  const files = [join(project, "fixtures", "llm", "storefront.json"), ...readdirSync(join(project, "tests", "fixtures", "llm")).filter((f) => f.endsWith(".json")).map((f) => join(project, "tests", "fixtures", "llm", f))];
  assert.ok(files.length >= 4, "storefront, adversarial, missing-key and unavailable");
  for (const file of files) {
    const fixture = llmFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const p of Object.values(PROMPTS)) assert.equal(fixture.promptHashes[p.name], promptHash(p), `${file}: ${p.name}`);
    for (const r of fixture.responses) assert.equal(r.key, llmKey(r.task, r.input), `${file}: ${r.label} (run npm run fixtures:rekey)`);
  }
});
