// Audit snapshot contracts (spec 5.1, 5.3). Pure: zod only.
import * as z from "zod";
import { nodeDescriptorSchema } from "./finding.ts";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] as const;

export const auditProfileSchema = z
  .object({
    axeTags: z.array(z.string()).min(1),
    keyboard: z.object({ maxTabs: z.number().int().min(1), trapRepeats: z.number().int().min(2) }).strict(),
    viewport: z.object({ width: z.number().int().min(1), height: z.number().int().min(1) }).strict(),
  })
  .strict();
export type AuditProfile = z.infer<typeof auditProfileSchema>;

export const DEFAULT_PROFILE: AuditProfile = {
  axeTags: [...AXE_TAGS],
  keyboard: { maxTabs: 200, trapRepeats: 3 },
  viewport: { width: 1280, height: 800 },
};

export const traversalStepSchema = z
  .object({
    index: z.number().int().min(0),
    selector: z.string(),
    tag: z.string(),
    id: z.string().nullable(),
    coveredPoints: z.number().int().min(0).max(5), // of the 5 sampled points, how many elementFromPoint returned a foreign element
    coveredBy: z.string().nullable(),
    tabindex: z.number().int().nullable(),
    hostKind: z.enum(["plain", "shadow-host", "iframe", "native-composite"]),
  })
  .strict();
export type TraversalStep = z.infer<typeof traversalStepSchema>;

export const traversalTraceSchema = z
  .object({
    steps: z.array(traversalStepSchema),
    stoppedBecause: z.enum(["cycle", "max-tabs", "body", "trap"]),
    interactiveCandidates: z.array(
      z
        .object({
          selector: z.string(),
          tag: z.string(),
          reason: z.enum(["onclick", "role-button", "role-link"]),
          focusable: z.boolean(),
          reached: z.boolean(),
          hasFocusableDescendant: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type TraversalTrace = z.infer<typeof traversalTraceSchema>;

// The only schemas that pass unknown fields through: axe adds fields between versions.
const axeCheckResultSchema = z.object({ id: z.string(), data: z.unknown().optional() }).passthrough();
const axeNodeResultSchema = z
  .object({
    target: z.array(z.union([z.string(), z.array(z.string())])), // a shadow node is an array element that is itself an array
    html: z.string(),
    failureSummary: z.string().optional(),
    any: z.array(axeCheckResultSchema),
    all: z.array(axeCheckResultSchema),
    none: z.array(axeCheckResultSchema),
  })
  .passthrough();
export const axeRawResultSchema = z
  .object({
    id: z.string(),
    impact: z.string().nullable().optional(),
    tags: z.array(z.string()),
    help: z.string(),
    helpUrl: z.string(),
    nodes: z.array(axeNodeResultSchema),
  })
  .passthrough();
export type AxeRawResult = z.infer<typeof axeRawResultSchema>;

export const auditSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    axeVersion: z.string(), // from results.testEngine.version
    treeSha256: z.string(), // key of recordings
    url: z.string(),
    pagePath: z.string(),
    title: z.string(),
    lang: z.string().nullable(),
    axe: z
      .object({
        violations: z.array(axeRawResultSchema),
        incomplete: z.array(axeRawResultSchema),
        passesCount: z.number().int().min(0),
        inapplicableCount: z.number().int().min(0),
        toolOptions: z.unknown(),
      })
      .strict(),
    nodes: z.record(z.string(), nodeDescriptorSchema), // keyed by JSON.stringify(axe target) or the traversal selector
    domIds: z.array(z.string()), // sorted, duplicates kept
    traversal: traversalTraceSchema,
    ariaSnapshot: z.string(), // body, truncated at 200 KB with a marker
    ariaByNode: z.record(z.string(), z.string()), // keyed by DOM node key "<tag>[<domTagIndex>]"
    screenshots: z.object({ fullPage: z.string() }).strict(), // relative to the out dir; empty in recorded mode
    timings: z.object({ loadMs: z.number().min(0), axeMs: z.number().min(0), keyboardMs: z.number().min(0) }).strict(),
  })
  .strict();
export type AuditSnapshot = z.infer<typeof auditSnapshotSchema>;

/** A recorded audit file, tests/fixtures/audits/<scenario>.<key12>.json (P-7). */
export const recordingFileSchema = z
  .object({
    recordingKey: z.string().regex(/^[0-9a-f]{64}$/), // sha256(treeSha256 + "\n" + sorted watch keys joined by ",")
    label: z.string().min(1),
    snapshot: auditSnapshotSchema,
  })
  .strict();
export type RecordingFile = z.infer<typeof recordingFileSchema>;
