// SARIF 2.1.0 subset of spec 5.8.1, strict where GitHub code scanning requires fields. Pure: zod only.
import * as z from "zod";

export const SARIF_SCHEMA_URI = "https://json.schemastore.org/sarif-2.1.0.json";
/** GitHub limits (spec Appendix A): results per run are capped by the tool at 1,000, tags per rule at 10. */
export const SARIF_MAX_RESULTS = 1000;
export const SARIF_MAX_TAGS = 10;

const line = z.number().int().min(1);

export const sarifRuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    shortDescription: z.object({ text: z.string().min(1) }).strict(),
    helpUri: z.string().min(1),
    properties: z.object({ tags: z.array(z.string()).max(SARIF_MAX_TAGS) }).strict(),
  })
  .strict();

export const sarifResultSchema = z
  .object({
    ruleId: z.string().min(1),
    level: z.enum(["error", "warning", "note"]),
    message: z.object({ text: z.string().min(1) }).strict(),
    locations: z
      .array(
        z
          .object({
            physicalLocation: z
              .object({
                artifactLocation: z.object({ uri: z.string().min(1), uriBaseId: z.literal("%SRCROOT%") }).strict(),
                region: z.object({ startLine: line, startColumn: line, endLine: line, endColumn: line }).strict(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
    partialFingerprints: z.object({ "a11yFixgate/v1": z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
    properties: z
      .object({
        impact: z.enum(["critical", "serious", "moderate", "minor"]),
        status: z.enum(["violation", "incomplete"]),
        wcag: z.array(z.string()),
        fixStatus: z.enum(["none", "accepted", "rejected", "suggest-only", "conflict", "skipped"]),
        verified: z.enum(["verified", "verified-present-needs-review"]).nullable(),
        strategy: z.string().nullable(),
        needsHumanReview: z.boolean(),
        uriOutsideRoot: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const sarifLogSchema = z
  .object({
    version: z.literal("2.1.0"),
    $schema: z.literal(SARIF_SCHEMA_URI),
    runs: z
      .array(
        z
          .object({
            tool: z
              .object({
                driver: z
                  .object({
                    name: z.string().min(1),
                    version: z.string().min(1),
                    informationUri: z.string().min(1),
                    rules: z.array(sarifRuleSchema),
                  })
                  .strict(),
              })
              .strict(),
            results: z.array(sarifResultSchema).max(SARIF_MAX_RESULTS),
            properties: z
              .object({
                unmappedCount: z.number().int().min(0),
                keyboardFindings: z.number().int().min(0),
                axeVersion: z.string(),
                repoRoot: z.string(),
                truncated: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .length(1), // one run
  })
  .strict();
export type SarifLog = z.infer<typeof sarifLogSchema>;
export type SarifResult = z.infer<typeof sarifResultSchema>;
export type SarifRule = z.infer<typeof sarifRuleSchema>;
