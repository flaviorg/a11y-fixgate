// AuditResult builders for the output tests.
import { auditConfigSchema } from "../../src/contracts/config.ts";
import type { AuditConfig } from "../../src/contracts/config.ts";
import type { AuditResult } from "../../src/contracts/result.ts";
import type { PatchInput } from "../../src/output/patch-file.ts";
import { makeSnapshot } from "./snapshots.ts";

const ZERO = { violations: 0, incomplete: 0, keyboard: 0, accepted: 0, verified: 0, verifiedNeedsReview: 0, rejected: 0, gateRejected: 0, suggestOnly: 0, unmapped: 0, conflicts: 0, skipped: 0, remainingInSource: 0, fixableByPatch: 0 };

/** A result with no findings (RF-1): what a clean page produces. */
export function emptyResult(config: Partial<AuditConfig> = {}): AuditResult & PatchInput {
  return {
    config: auditConfigSchema.parse({ sourceRoot: "/work/site", out: "/work/out", browser: { executablePath: null, source: "recorded" }, llm: { provider: "none" }, ...config }),
    baseline: makeSnapshot(),
    findings: [],
    outcomes: [],
    combined: null,
    summary: { ...ZERO },
    timings: { baselineMs: 1, loopMs: 0, combinedMs: 0, totalMs: 1 },
    limits: { candidatesUsed: 0, llmCallsUsed: 0, deadlineHit: false },
    llm: { provider: "none", calls: 0, promptVersion: "v1" },
    warnings: [],
    written: null,
    baselineFiles: {},
    combinedFiles: {},
    writtenFiles: {},
  };
}
