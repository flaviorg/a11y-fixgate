// results.sarif (spec 5.8.1, OUT-03): SARIF 2.1.0, one run, results only for mapped findings still present in the files.
import { basename } from "node:path";
import { isUnmapped } from "../contracts/finding.ts";
import type { Finding } from "../contracts/finding.ts";
import type { FixOutcome } from "../contracts/fix.ts";
import type { AuditResult } from "../contracts/result.ts";
import { SARIF_MAX_RESULTS, SARIF_MAX_TAGS, SARIF_SCHEMA_URI, sarifLogSchema } from "../contracts/sarif.ts";
import type { SarifLog, SarifResult, SarifRule } from "../contracts/sarif.ts";
import { TOOL } from "../contracts/tool.ts";
import { remainingFindings } from "../domain/findings.ts";
import { redactSecrets } from "../infra/redact.ts";
import { repoRelative } from "./patch-file.ts";

type FixStatus = SarifResult["properties"]["fixStatus"];
type FixInfo = { fixStatus: FixStatus; verified: SarifResult["properties"]["verified"]; strategy: string | null; needsHumanReview: boolean };

const NONE: FixInfo = { fixStatus: "none", verified: null, strategy: null, needsHumanReview: false };

/** error for critical and serious violations, warning for moderate, note for minor; every incomplete is a note; unreachable-control is a warning. */
export function levelOf(f: Finding): SarifResult["level"] {
  if (f.status === "incomplete") return "note";
  if (f.ruleId === "unreachable-control") return "warning";
  if (f.impact === "critical" || f.impact === "serious") return "error";
  return f.impact === "moderate" ? "warning" : "note";
}

/** The fix status of one baseline finding, from its outcomes (precedence: accepted and included, conflict, suggest-only, rejected, skipped). */
function fixInfoOf(result: AuditResult, f: Finding): FixInfo {
  const own = result.outcomes.filter((o) => ("candidate" in o ? o.candidate.findingId : o.findingId) === f.id);
  const included = new Set(result.combined?.included ?? []);
  const accepted = own.find((o): o is Extract<FixOutcome, { status: "accepted" }> => o.status === "accepted" && included.has(o.candidate.findingId));
  if (accepted) {
    const plan = accepted.candidate.plan;
    return { fixStatus: "accepted", verified: accepted.verified, strategy: plan.strategy, needsHumanReview: plan.needsHumanReview };
  }
  if (own.some((o) => o.status === "conflict")) return { ...NONE, fixStatus: "conflict" };
  if (own.some((o) => o.status === "suggest-only")) {
    const s = own.find((o): o is Extract<FixOutcome, { status: "suggest-only" }> => o.status === "suggest-only")!;
    return { ...NONE, fixStatus: "suggest-only", strategy: s.plan.strategy };
  }
  if (own.some((o) => o.status === "rejected" || o.status === "gate-rejected")) return { ...NONE, fixStatus: "rejected" };
  if (own.some((o) => o.status === "skipped")) return { ...NONE, fixStatus: "skipped" };
  return NONE;
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function ruleOf(f: Finding): SarifRule {
  const tags = ["accessibility", "wcag2.2", ...f.wcag.map((c) => `wcag-${c}`)].slice(0, SARIF_MAX_TAGS);
  return { id: f.ruleId, name: f.ruleId, shortDescription: { text: f.help || f.ruleId }, helpUri: f.helpUrl || TOOL.informationUri, properties: { tags } };
}

/**
 * The SARIF log of a run. Results are the mapped findings still in the files (remainingFindings: the baseline,
 * or the audit of the written tree after --write). A finding whose fix only exists in fixes.patch is still an
 * open alert and says so. repoRoot is the SARIF root (%SRCROOT%); a file outside it is given relative to --src.
 */
export function toSarif(result: AuditResult, { sourceRoot, repoRoot }: { sourceRoot: string; repoRoot: string }): SarifLog {
  const remaining = remainingFindings(result);
  // The remaining findings of a written tree have their own ids; the outcomes are keyed by baseline ids, so match by fingerprint.
  const baselineByFingerprint = new Map<string, Finding>();
  for (const f of result.findings) if (!baselineByFingerprint.has(f.fingerprint)) baselineByFingerprint.set(f.fingerprint, f);

  const rules = new Map<string, SarifRule>();
  const results: SarifResult[] = [];
  let truncated = false;
  for (const f of remaining) {
    if (isUnmapped(f.location)) continue;
    if (results.length >= SARIF_MAX_RESULTS) {
      truncated = true;
      break;
    }
    const base = baselineByFingerprint.get(f.fingerprint) ?? f;
    const info = fixInfoOf(result, base);
    if (!rules.has(f.ruleId)) rules.set(f.ruleId, ruleOf(f));
    const where = repoRelative(f.location.file, sourceRoot, repoRoot);
    const first = oneLine(f.message.split("\n")[0] ?? "", 200);
    const suffix =
      info.fixStatus === "accepted" ? `. fixes.patch resolves this (${info.verified === "verified" ? "verified in a browser" : "needs human review"})` : "";
    results.push({
      ruleId: f.ruleId,
      level: levelOf(f),
      message: { text: `${oneLine(f.help, 200)}${first ? `: ${first}` : ""} (${f.node.tag}${f.status === "incomplete" ? ", needs review" : ""})${suffix}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: where.path, uriBaseId: "%SRCROOT%" },
            region: { startLine: f.location.startLine, startColumn: f.location.startCol, endLine: Math.max(f.location.endLine, f.location.startLine), endColumn: f.location.endCol },
          },
        },
      ],
      partialFingerprints: { "a11yFixgate/v1": f.fingerprint },
      properties: {
        impact: f.impact,
        status: f.status,
        wcag: f.wcag,
        fixStatus: info.fixStatus,
        verified: info.verified,
        strategy: info.strategy,
        needsHumanReview: info.needsHumanReview,
        ...(where.outside ? { uriOutsideRoot: true } : {}),
      },
    });
  }

  const log: SarifLog = {
    version: "2.1.0",
    $schema: SARIF_SCHEMA_URI,
    runs: [
      {
        tool: { driver: { name: TOOL.name, version: TOOL.version, informationUri: TOOL.informationUri, rules: [...rules.values()] } },
        results,
        properties: {
          unmappedCount: remaining.filter((f) => isUnmapped(f.location)).length,
          keyboardFindings: remaining.filter((f) => f.source === "keyboard").length,
          axeVersion: result.baseline.axeVersion,
          // Only the directory name: an absolute path of the machine has no place in a file that is uploaded.
          repoRoot: basename(repoRoot) || ".",
          ...(truncated ? { truncated: true } : {}),
        },
      },
    ],
  };
  return sarifLogSchema.parse(redactSecrets(log));
}
