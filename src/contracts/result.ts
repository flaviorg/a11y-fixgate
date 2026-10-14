// AuditResult contract (spec 5.1): what the outputs render. Pure: zod only.
import * as z from "zod";
import { auditConfigSchema } from "./config.ts";
import { findingSchema } from "./finding.ts";
import { fixOutcomeSchema } from "./fix.ts";
import { auditSnapshotSchema } from "./snapshot.ts";

const count = z.number().int().min(0);

/** The 14 counters of spec 5.1. remainingInSource counts findings still in the files on disk; fixableByPatch those the combined patch would remove. */
export const summarySchema = z
  .object({
    violations: count,
    incomplete: count,
    keyboard: count,
    accepted: count,
    verified: count,
    verifiedNeedsReview: count,
    rejected: count,
    gateRejected: count,
    suggestOnly: count,
    unmapped: count,
    conflicts: count,
    skipped: count,
    remainingInSource: count,
    fixableByPatch: count,
  })
  .strict();
export type Summary = z.infer<typeof summarySchema>;

export const auditResultSchema = z
  .object({
    config: auditConfigSchema,
    baseline: auditSnapshotSchema,
    findings: z.array(findingSchema),
    outcomes: z.array(fixOutcomeSchema),
    combined: z
      .object({ snapshot: auditSnapshotSchema, remaining: z.array(findingSchema), included: z.array(z.string()) })
      .strict()
      .nullable(),
    summary: summarySchema,
    timings: z.object({ baselineMs: z.number().min(0), loopMs: z.number().min(0), combinedMs: z.number().min(0), totalMs: z.number().min(0) }).strict(),
    limits: z.object({ candidatesUsed: count, llmCallsUsed: count, deadlineHit: z.boolean() }).strict(),
    llm: z.object({ provider: z.enum(["none", "fake", "openai-compatible", "anthropic"]), calls: count, promptVersion: z.string() }).strict(),
    warnings: z.array(z.string()),
    /**
     * Set when --write was given (plan deviation, Task 31): the files written, the finding ids whose fixes they
     * contain and the findings of the audit of the written tree, which are what remains in the source.
     * Null without --write, and then the baseline findings are what remains.
     */
    written: z
      .object({ files: z.array(z.string()), fixes: z.array(z.string()), remaining: z.array(findingSchema) })
      .strict()
      .nullable(),
  })
  .strict();
export type AuditResult = z.infer<typeof auditResultSchema>;

/** audit.json (spec 5.8, OUT-04): the result plus its schema version. */
export const auditJsonSchema = auditResultSchema.extend({ schemaVersion: z.literal(1) });
export type AuditJson = z.infer<typeof auditJsonSchema>;
