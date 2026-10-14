// Finding contracts (spec 5.1). Pure: zod only.
import * as z from "zod";

export type Fingerprint = string & { readonly __brand: "Fingerprint" };
export const fingerprintSchema = z.custom<Fingerprint>(
  (value) => typeof value === "string" && /^[0-9a-f]{16}$/.test(value),
  "must be 16 lower-case hex characters",
);

export const impactSchema = z.enum(["critical", "serious", "moderate", "minor"]);
export type Impact = z.infer<typeof impactSchema>;

export const findingSourceSchema = z.enum(["axe", "keyboard"]);
export type FindingSource = z.infer<typeof findingSourceSchema>;

export const findingStatusSchema = z.enum(["violation", "incomplete"]);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export const nodeDescriptorSchema = z
  .object({
    selector: z.string(), // JSON.stringify(axe target) or the traversal's generated selector (diagnostic only; never identity)
    tag: z.string(), // lower-case
    attrs: z.record(z.string(), z.string()),
    text: z.string(), // textContent, whitespace collapsed, max 200 chars (cut in the page)
    domTagIndex: z.number().int().min(-1), // index among document.querySelectorAll(tag); -1 for a node never queried (shadow root or iframe target)
    domTagCount: z.number().int().min(0), // 0 for a node never queried
    htmlSnippet: z.string(), // outerHTML, whitespace collapsed, max 400 chars (cut in the page)
    rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict(),
    dataSource: z.string().nullable(), // value of data-a11y-source when present
  })
  .strict();
export type NodeDescriptor = z.infer<typeof nodeDescriptorSchema>;

const offsetRangeSchema = z
  .object({ startOffset: z.number().int().min(0), endOffset: z.number().int().min(0) })
  .strict();

export const sourceLocationSchema = z
  .object({
    file: z.string().min(1), // relative to sourceRoot, posix separators
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0), // whole element (start tag to end tag)
    startTag: offsetRangeSchema,
    attrs: z.record(z.string(), offsetRangeSchema),
    startLine: z.number().int().min(1),
    startCol: z.number().int().min(1),
    endLine: z.number().int().min(1),
    endCol: z.number().int().min(1),
    tagOrdinal: z.number().int().min(0), // index among elements with the same tag in the file
    method: z.enum(["attribute", "ordinal", "signature"]),
  })
  .strict();
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

export const unmappedReasonSchema = z.enum(["no-page-file", "attribute-mismatch", "no-candidate", "ambiguous", "dom-only"]);
export const unmappedSchema = z.object({ reason: unmappedReasonSchema }).strict();
export type Unmapped = z.infer<typeof unmappedSchema>;

export function isUnmapped(x: SourceLocation | Unmapped): x is Unmapped {
  return "reason" in x;
}

export const findingSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/), // "<ruleId>-<n>": filename-safe, never "#"
    source: findingSourceSchema,
    ruleId: z.string().min(1),
    status: findingStatusSchema,
    impact: impactSchema,
    wcag: z.array(z.string()),
    level: z.enum(["A", "AA"]),
    help: z.string(),
    helpUrl: z.string(),
    message: z.string(),
    node: nodeDescriptorSchema,
    location: z.union([sourceLocationSchema, unmappedSchema]),
    fingerprint: fingerprintSchema, // fingerprintOf(ruleId, anchor); status is not part of it
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;
