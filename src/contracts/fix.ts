// Fix contracts (spec 4.4, 5.1, 5.6). Pure: zod only. Shared across layers (plan P-5).
import * as z from "zod";
import { fingerprintSchema, unmappedReasonSchema } from "./finding.ts";
import type { Fingerprint } from "./finding.ts";

const offset = z.number().int().min(0);

/** file is relative to sourceRoot, posix separators. */
export const sourceRangeSchema = z.object({ file: z.string().min(1), startOffset: offset, endOffset: offset }).strict();
export type SourceRange = z.infer<typeof sourceRangeSchema>;

/**
 * attribute: insert or replace one attribute inside a start tag.
 * element-insert: insert a whole element (only <title> in v1).
 * startTag is the range of the start tag the edit belongs to, used for overlap detection.
 */
export const editSchema = z
  .object({
    range: sourceRangeSchema,
    replacement: z.string(),
    kind: z.enum(["attribute", "element-insert"]),
    startTag: sourceRangeSchema,
  })
  .strict();
export type Edit = z.infer<typeof editSchema>;

export const strategyKindSchema = z.enum(["deterministic", "llm", "suggest-only"]);
export type StrategyKind = z.infer<typeof strategyKindSchema>;

export const fixPlanSchema = z
  .object({
    strategy: z.string().min(1),
    kind: strategyKindSchema,
    edits: z.array(editSchema), // empty for suggest-only
    summary: z.string(),
    needsHumanReview: z.boolean(),
    reviewReason: z.enum(["llm-text", "design-review", "inferred-lang"]).nullable(),
    generatedIds: z.array(z.string()),
    llm: z
      .object({ task: z.string(), requestId: z.string(), attempt: z.number().int().min(1), proposal: z.unknown(), gate: z.literal("passed") })
      .strict()
      .optional(),
  })
  .strict();
export type FixPlan = z.infer<typeof fixPlanSchema>;

export const fixCandidateSchema = z
  .object({
    findingId: z.string().min(1),
    fingerprint: fingerprintSchema,
    plan: fixPlanSchema,
    patch: z.string(),
    patchedFiles: z.record(z.string(), z.string()),
    patchSha256: z.string(),
  })
  .strict();
export type FixCandidate = z.infer<typeof fixCandidateSchema>;

export const rejectReasonSchema = z.enum(["target-still-present", "new-violation", "new-incomplete", "violation-downgraded", "new-keyboard-finding"]);
export type RejectReason = z.infer<typeof rejectReasonSchema>;

export const verdictSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), targetGone: z.literal(true), warnings: z.array(z.string()) }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      reasons: z.array(rejectReasonSchema),
      targetGone: z.boolean(),
      newViolations: z.array(z.string()),
      newIncomplete: z.array(z.string()),
    })
    .strict(),
]);
export type Verdict = z.infer<typeof verdictSchema>;

/** Every member is a Fingerprint from fingerprintOf; status only decides the bucket. */
export type FindingSet = { violations: Set<Fingerprint>; incomplete: Set<Fingerprint>; keyboard: Set<Fingerprint> };

export const verifiedStatusSchema = z.enum(["verified", "verified-present-needs-review"]); // deterministic fix | LLM-written value
export type VerifiedStatus = z.infer<typeof verifiedStatusSchema>;

export const valueGateReasonSchema = z.enum([
  "alt-empty",
  "alt-too-long",
  "alt-has-markup",
  "alt-has-url",
  "alt-has-newline",
  "alt-is-filename",
  "alt-redundant-prefix",
  "alt-equals-adjacent-text",
  "decorative-inside-control",
  "name-empty",
  "name-too-long",
  "name-has-markup",
  "name-has-url",
  "name-equals-href",
  "name-generic",
  "schema-invalid",
]);
export type ValueGateReason = z.infer<typeof valueGateReasonSchema>;

export const gateRejectReasonSchema = z.union([
  valueGateReasonSchema,
  z.enum(["llm-invalid", "llm-unavailable", "patch-out-of-bounds"]),
]);
export type GateRejectReason = z.infer<typeof gateRejectReasonSchema>;

/** P-15: the rejected outcome names the new findings so the summary, logs and report can show them. */
export const newFindingRefSchema = z.object({ fingerprint: fingerprintSchema, ruleId: z.string(), anchor: z.string() }).strict();
export type NewFindingRef = z.infer<typeof newFindingRefSchema>;

export const fixOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("accepted"), verified: verifiedStatusSchema, candidate: fixCandidateSchema, verdict: verdictSchema, afterSnapshotSha: z.string() })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      candidate: fixCandidateSchema,
      verdict: verdictSchema,
      afterSnapshotSha: z.string(),
      newFindings: z.array(newFindingRefSchema),
    })
    .strict(),
  z
    .object({ status: z.literal("gate-rejected"), findingId: z.string(), strategy: z.string(), reason: gateRejectReasonSchema, proposal: z.unknown() })
    .strict(),
  z.object({ status: z.literal("unmapped"), findingId: z.string(), reason: unmappedReasonSchema }).strict(),
  z
    .object({
      status: z.literal("suggest-only"),
      findingId: z.string(),
      plan: fixPlanSchema,
      reason: z.enum(["catalog", "decorative-needs-decision", "lang-unknown", "llm-disabled", "no-scripted-answer"]),
    })
    .strict(),
  z.object({ status: z.literal("conflict"), findingId: z.string(), with: z.string(), reason: z.enum(["overlap", "id-collision"]) }).strict(),
  z
    .object({
      status: z.literal("skipped"),
      findingId: z.string(),
      reason: z.enum(["max-fixes", "max-candidates", "max-llm-calls", "deadline", "no-strategy"]),
    })
    .strict(),
]);
export type FixOutcome = z.infer<typeof fixOutcomeSchema>;
