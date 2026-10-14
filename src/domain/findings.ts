// Snapshot to ordered, mapped and fingerprinted findings (spec 5.1, 5.6; P-4). Pure.
import { impactSchema, isUnmapped } from "../contracts/finding.ts";
import type { Finding, FindingStatus, Impact, NodeDescriptor } from "../contracts/finding.ts";
import type { FindingSet } from "../contracts/fix.ts";
import type { AuditProfile, AuditSnapshot, AxeRawResult } from "../contracts/snapshot.ts";
import { analyzeKeyboard, KEYBOARD_HELP } from "./keyboard/analyze.ts";
import type { HtmlIndex } from "./map/html-index.ts";
import { mapNode } from "./map/source-map.ts";
import { anchorOf, fingerprintOf } from "./verify/fingerprint.ts";

export type { FindingSet } from "../contracts/fix.ts";

type Draft = Omit<Finding, "id" | "location" | "fingerprint">;

const WCAG_SC = /^wcag(\d)(\d)(\d+)$/;
const WCAG_AA = /^wcag2\d*aa$/;

/** "wcag111" to "1.1.1", "wcag1410" to "1.4.10"; level AA when any wcag2*aa tag is present (wcag2aa, wcag21aa, wcag22aa). */
function wcagOf(tags: string[]): { wcag: string[]; level: "A" | "AA" } {
  const wcag = tags.flatMap((t) => {
    const m = WCAG_SC.exec(t);
    return m ? [`${m[1]}.${m[2]}.${m[3]}`] : [];
  });
  return { wcag, level: tags.some((t) => WCAG_AA.test(t)) ? "AA" : "A" };
}

function impactOf(value: unknown): Impact {
  const parsed = impactSchema.safeParse(value);
  return parsed.success ? parsed.data : "minor";
}

function dataOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

/** A node the snapshot does not describe: treated like a shadow or iframe node, never queried or guessed. */
function undescribed(key: string, html: string): NodeDescriptor {
  return { selector: key, tag: "unknown", attrs: {}, text: "", domTagIndex: -1, domTagCount: 0, htmlSnippet: html.replace(/\s+/g, " ").trim().slice(0, 400), rect: { x: 0, y: 0, width: 0, height: 0 }, dataSource: null };
}

function axeDrafts(results: AxeRawResult[], status: FindingStatus, snapshot: AuditSnapshot): Draft[] {
  const out: Draft[] = [];
  for (const r of results) {
    const { wcag, level } = wcagOf(r.tags);
    for (const n of r.nodes) {
      const key = JSON.stringify(n.target);
      out.push({
        source: "axe",
        ruleId: r.id,
        status,
        impact: impactOf(r.impact),
        wcag,
        level,
        help: r.help,
        helpUrl: r.helpUrl,
        message: n.failureSummary ?? "",
        node: snapshot.nodes[key] ?? undescribed(key, n.html),
        data: dataOf(n.any[0]?.data),
      });
    }
  }
  return out;
}

const safeRuleId = (ruleId: string) => ruleId.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/**
 * Axe violations and incomplete nodes (one finding each) plus the keyboard drafts, mapped and fingerprinted.
 * Order (P-4): mapped findings by (file, startOffset), then unmapped ones; ties keep snapshot order
 * (violations, incomplete, keyboard, each in axe or check order). Ids are "<ruleId>-<n>", n from 1 per rule.
 */
export function analyzeSnapshot(snapshot: AuditSnapshot, index: HtmlIndex, pageFile: string | null, profile: AuditProfile): Finding[] {
  const drafts: Draft[] = [
    ...axeDrafts(snapshot.axe.violations, "violation", snapshot),
    ...axeDrafts(snapshot.axe.incomplete, "incomplete", snapshot),
    ...analyzeKeyboard(snapshot.traversal, { trapRepeats: profile.keyboard.trapRepeats }).map(
      (d): Draft => ({
        source: "keyboard",
        ruleId: d.ruleId,
        status: d.status,
        impact: d.impact,
        wcag: d.wcag,
        level: d.level,
        help: KEYBOARD_HELP[d.ruleId].help,
        helpUrl: KEYBOARD_HELP[d.ruleId].helpUrl,
        message: d.message,
        node: snapshot.nodes[d.nodeKey] ?? undescribed(d.nodeKey, ""),
        data: d.data,
      }),
    ),
  ];

  const located = drafts.map((d, order) => {
    const location = mapNode(d.node, index, pageFile);
    return { d, order, location, fingerprint: fingerprintOf(d.ruleId, anchorOf(location, d.node)) };
  });
  located.sort((a, b) => {
    const am = !isUnmapped(a.location);
    const bm = !isUnmapped(b.location);
    if (am !== bm) return am ? -1 : 1;
    if (!isUnmapped(a.location) && !isUnmapped(b.location)) {
      if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
      if (a.location.startOffset !== b.location.startOffset) return a.location.startOffset - b.location.startOffset;
    }
    return a.order - b.order;
  });

  const counters = new Map<string, number>();
  return located.map(({ d, location, fingerprint }) => {
    const rule = safeRuleId(d.ruleId);
    const n = (counters.get(rule) ?? 0) + 1;
    counters.set(rule, n);
    return { id: `${rule}-${n}`, ...d, location, fingerprint };
  });
}

/** Buckets fingerprints by source and status; keyboard findings go to keyboard whatever their status. */
export function findingSetOf(findings: Finding[]): FindingSet {
  const set: FindingSet = { violations: new Set(), incomplete: new Set(), keyboard: new Set() };
  for (const f of findings) {
    if (f.source === "keyboard") set.keyboard.add(f.fingerprint);
    else if (f.status === "violation") set.violations.add(f.fingerprint);
    else set.incomplete.add(f.fingerprint);
  }
  return set;
}

/** The findings still present in the files on disk: the baseline, or the audit of the written tree after --write (spec 5.1). */
export function remainingFindings(result: { findings: Finding[]; written: { remaining: Finding[] } | null }): Finding[] {
  return result.written ? result.written.remaining : result.findings;
}
