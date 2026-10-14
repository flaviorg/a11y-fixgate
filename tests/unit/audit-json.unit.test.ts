// audit.json (spec 5.8; OUT-04, RF-1).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { auditJsonSchema, auditResultSchema } from "../../src/contracts/result.ts";
import type { AuditResult } from "../../src/contracts/result.ts";
import { toAuditJson } from "../../src/output/audit-json.ts";
import { emptyResult } from "../helpers/results.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";

const PROJECT = join(import.meta.dirname, "..", "..");
let cached: Promise<AuditResult> | null = null;
const storefront = (): Promise<AuditResult> => (cached ??= runAuditRecorded("storefront"));

function assertSorted(value: unknown, path = "$"): void {
  if (Array.isArray(value)) return value.forEach((v, i) => assertSorted(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    assert.deepEqual(keys, [...keys].sort(), `keys of ${path} are sorted`);
    for (const k of keys) assertSorted((value as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

test("[OUT-04] audit.json validates against the result schema, has stable key order and contains no absolute path and no secret", async () => {
  const result = structuredClone(await storefront());
  const key = "sk-or-v1-" + "b".repeat(40);
  result.config.llm = { provider: "openai-compatible", baseUrl: `https://user:pw@openrouter.ai/api/v1`, model: "m", apiKey: key, timeoutMs: 30000, requestOverrides: {} };
  result.config.browser = { executablePath: "/Users/someone/.cache/chrome", source: "env" };
  result.findings[0]!.message = `leaked ${key}`;
  const text = toAuditJson(result, { sourceRoot: result.config.sourceRoot, repoRoot: PROJECT });
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.ok(auditJsonSchema.safeParse(parsed).success, "validates against the result schema plus schemaVersion");
  const { schemaVersion, ...rest } = parsed;
  assert.equal(schemaVersion, 1);
  assert.ok(auditResultSchema.safeParse(rest).success);
  assertSorted(parsed);
  assert.equal(Object.keys(parsed)[0], "baseline");
  assert.equal(text.includes(key), false);
  assert.equal(text.includes("pw@"), false);
  assert.equal(text.includes("/Users/"), false);
  assert.equal(text.includes(result.config.sourceRoot), false);
  assert.equal(text.includes(result.config.out), false);
  const cfg = parsed["config"] as AuditResult["config"];
  assert.equal(cfg.sourceRoot, "fixtures/storefront");
  assert.equal(cfg.browser.executablePath, null);
  assert.equal(cfg.llm.provider === "openai-compatible" && cfg.llm.apiKey, "[REDACTED]");
  assert.equal(text.endsWith("\n"), true);
});

test("[OUT-04] the same result always serializes to the same text, whatever the key order of its objects", async () => {
  const result = await storefront();
  const a = toAuditJson(result, { sourceRoot: result.config.sourceRoot, repoRoot: PROJECT });
  const shuffled = structuredClone(result);
  shuffled.summary = Object.fromEntries(Object.entries(shuffled.summary).reverse()) as typeof shuffled.summary;
  shuffled.baseline = Object.fromEntries(Object.entries(shuffled.baseline).reverse()) as typeof shuffled.baseline;
  assert.equal(toAuditJson(shuffled, { sourceRoot: result.config.sourceRoot, repoRoot: PROJECT }), a);
});

test("[OUT-04] an AuditRun's diffs and file contents are not part of audit.json", async () => {
  const run = await storefront();
  assert.ok("combinedFiles" in run && "diffs" in run);
  const text = toAuditJson(run, { sourceRoot: run.config.sourceRoot, repoRoot: PROJECT });
  for (const field of ["combinedFiles", "baselineFiles", "writtenFiles", "diffs"]) assert.equal(text.includes(`"${field}"`), false, field);
});

test("[RF-1] an empty result serializes and validates", () => {
  const result = emptyResult();
  const parsed = JSON.parse(toAuditJson(result, { sourceRoot: result.config.sourceRoot, repoRoot: "/work" }));
  assert.ok(auditJsonSchema.safeParse(parsed).success);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.config.sourceRoot, "site");
  assert.equal(parsed.config.out, "out");
});
