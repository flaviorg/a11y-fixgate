// The human summary of a run (spec 10.2) and the --json line. Pure string building; the caller writes it
// through writeOut(), which redacts. The CLI and scripts/demo.ts share this layout.
import { isUnmapped } from "../contracts/finding.ts";
import type { Finding } from "../contracts/finding.ts";
import type { FixOutcome } from "../contracts/fix.ts";
import type { AuditResult } from "../contracts/result.ts";
import { DEFAULT_PROFILE } from "../contracts/snapshot.ts";
import { TOOL } from "../contracts/tool.ts";
import { remainingFindings } from "../domain/findings.ts";
import { domKey } from "../domain/verify/fingerprint.ts";

const pad = (s: string, n: number): string => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));
const findingIdOf = (o: FixOutcome): string => ("candidate" in o ? o.candidate.findingId : o.findingId);

function countBy(items: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()];
}

function verifiedLabel(o: Extract<FixOutcome, { status: "accepted" }>): string {
  if (o.verified === "verified") return "verified";
  return o.candidate.plan.reviewReason === "design-review" ? "verified present, design review" : "verified present, needs review";
}

function kindOfStrategy(name: string): string {
  return name.endsWith("-llm") ? "llm" : "deterministic";
}

/** Advice text for one line: the first sentence, without :nth-of-type(n), cut at a word boundary. The report has it whole. */
function brief(text: string, max = 110): string {
  const first = (text.split(/\.\s/)[0] ?? text).replace(/:nth-of-type\(\d+\)/g, "").replace(/\s+/g, " ").trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 3);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd() + "...";
}

/** A node selector as plain text: the serialized axe target `[".promo"]` or a selector string. */
function plainSelector(selector: string): string {
  try {
    const parsed: unknown = JSON.parse(selector);
    if (Array.isArray(parsed)) return parsed.flat().join(" ");
  } catch {
    // not JSON: already a selector
  }
  return selector;
}

/** The last compound of a selector without its :nth-of-type(n): "#main > div.cards:nth-of-type(1) > div.btn" gives "div.btn". */
function shortSelector(selector: string): string {
  const last = plainSelector(selector).split(" > ").at(-1) ?? selector;
  return last.replace(/:nth-of-type\(\d+\)/g, "");
}

/** shortSelector with the tag in front when the selector is only a class or an id: ".promo" on an <a> gives "a.promo". */
function nodeLabel(node: { tag: string; selector: string }): string {
  const short = shortSelector(node.selector);
  return /^[.#[]/.test(short) ? `${node.tag}${short}` : short;
}

type Widths = { rule: number; strategy: number };

function strategyOf(o: FixOutcome): string {
  switch (o.status) {
    case "accepted":
    case "rejected":
      return o.candidate.plan.strategy;
    case "suggest-only":
      return o.plan.strategy;
    case "gate-rejected":
      return o.strategy;
    case "unmapped":
      return "unmapped";
    case "conflict":
      return "combine";
    case "skipped":
      return "";
  }
}

/** One line per outcome: rule, strategy, kind, status and what happened. */
function outcomeLine(f: Finding | undefined, o: FixOutcome, w: Widths): string {
  const rule = pad(f?.ruleId ?? findingIdOf(o), w.rule);
  switch (o.status) {
    case "accepted": {
      const p = o.candidate.plan;
      const attempt = p.llm && p.llm.attempt > 1 ? ` (attempt ${p.llm.attempt})` : "";
      return `${rule}${pad(p.strategy, w.strategy)}${pad(p.kind, 15)}${pad("accepted", 11)}${p.summary}${attempt}  ${verifiedLabel(o)}`;
    }
    case "rejected": {
      const p = o.candidate.plan;
      const reasons = o.verdict.status === "rejected" ? o.verdict.reasons.join(", ") : "";
      const rules = [...new Set(o.newFindings.map((n) => n.ruleId))];
      // An LLM value reaches the loop only after every value gate passed; only the browser re-audit caught it.
      const gate = p.kind === "llm" ? " passed every value gate;" : ";";
      return `${rule}${pad(p.strategy, w.strategy)}${pad(p.kind, 15)}${pad("REJECTED", 11)}${p.summary}${gate} re-audit: ${reasons}${rules.length ? `: ${rules.join(", ")}` : ""}`;
    }
    case "gate-rejected":
      return `${rule}${pad(o.strategy, w.strategy)}${pad(kindOfStrategy(o.strategy), 15)}gate-rejected (${o.reason})`;
    case "suggest-only":
      return `${rule}${pad(o.plan.strategy, w.strategy)}${pad(o.plan.kind, 15)}${pad("suggest", 11)}${brief(o.plan.summary)} (${o.reason})`;
    case "unmapped":
      return `${rule}${pad("unmapped", w.strategy)}${pad("no patch", 15)}${o.reason}`;
    case "conflict":
      return `${rule}${pad("combine", w.strategy)}${pad("", 15)}${pad("conflict", 11)}with ${o.with} (${o.reason})`;
    case "skipped":
      return `${rule}${pad("", w.strategy)}${pad("", 15)}${pad("skipped", 11)}${o.reason}`;
  }
}

/** The first line of an aria snapshot as a reader would say it: `- 'link "Sale: shop deals"':` gives `link "Sale: shop deals"`. */
function ariaHead(aria: string): string {
  let head = (aria.split("\n")[0] ?? "").replace(/^- /, "").replace(/:$/, "");
  if (head.startsWith("'") && head.endsWith("'")) head = head.slice(1, -1).replace(/''/g, "'");
  return head;
}

/**
 * "Screen reader view, a.promo:  - link  ->  + link "Sale: shop deals"": for every finding whose LLM fix was rejected
 * once and then accepted, the first line of the element's accessibility tree before and after the combined fixes.
 */
function screenReaderLines(result: AuditResult): string[] {
  if (!result.combined) return [];
  const lines: string[] = [];
  for (const f of result.findings) {
    if (f.node.domTagIndex < 0) continue;
    const own = result.outcomes.filter((o) => findingIdOf(o) === f.id);
    const retried = own.some((o) => o.status === "rejected") && own.some((o) => o.status === "accepted" && o.candidate.plan.kind === "llm");
    if (!retried) continue;
    const key = domKey(f.node);
    const before = result.baseline.ariaByNode[key];
    const after = result.combined.snapshot.ariaByNode[key];
    if (before === undefined || after === undefined || before === after) continue;
    lines.push(`Screen reader view, ${nodeLabel(f.node)}:  - ${ariaHead(before)}  ->  + ${ariaHead(after)}`);
  }
  return lines;
}

/** The Accepted/rejected/... line of spec 10.2. */
function totalsLine(result: AuditResult): string {
  const s = result.summary;
  const accepted = result.outcomes.filter((o): o is Extract<FixOutcome, { status: "accepted" }> => o.status === "accepted");
  const reasons = [
    [accepted.filter((o) => o.candidate.plan.reviewReason === "llm-text").length, "LLM"],
    [accepted.filter((o) => o.candidate.plan.reviewReason === "design-review").length, "design review"],
    [accepted.filter((o) => o.candidate.plan.reviewReason === "inferred-lang").length, "inferred lang"],
  ] as const;
  const split = reasons.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const review = `needs human review ${s.verifiedNeedsReview}${s.verifiedNeedsReview > 0 && split.length ? `: ${split.join(" + ")}` : ""}`;
  const retried = result.outcomes.filter((o, i) => o.status === "gate-rejected" && result.outcomes.slice(i + 1).some((n) => findingIdOf(n) === findingIdOf(o))).length;
  const gate = `gate-rejected ${s.gateRejected}${retried > 0 ? (retried === s.gateRejected ? " (retried)" : ` (${retried} retried)`) : ""}`;
  const extra = [s.conflicts > 0 ? ` | conflicts ${s.conflicts}` : "", s.skipped > 0 ? ` | skipped ${s.skipped}` : ""].join("");
  return `Accepted ${s.accepted} (verified ${s.verified}, ${review}) | rejected ${s.rejected} | ${gate} | suggest-only ${s.suggestOnly} | unmapped ${s.unmapped}${extra}`;
}

export type SummaryOptions = {
  mode: string;
  llmLabel: string;
  /** The first words of the header line; default "<tool> <version>". The demo passes "<tool> demo". */
  title?: string;
  /** Replaces the "Page: ..." line (the demo names the file and the loopback URL). */
  pageLine?: string;
};

export function formatSummary(result: AuditResult, opts: SummaryOptions): string {
  const { findings, summary: s, baseline } = result;
  const lines: string[] = [];
  lines.push(`${opts.title ?? `${TOOL.name} ${TOOL.version}`} | audit: ${opts.mode} | LLM: ${opts.llmLabel} | lang: ${result.config.lang ?? "not set"}`);
  lines.push(opts.pageLine ?? `Page: ${baseline.pagePath}  axe-core ${baseline.axeVersion}  tags: ${DEFAULT_PROFILE.axeTags.join(" ")}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No findings: axe and the keyboard checks found nothing on this page.");
    lines.push("No fixes to apply.");
    return lines.join("\n");
  }

  const violations = findings.filter((f) => f.source === "axe" && f.status === "violation");
  const incomplete = findings.filter((f) => f.source === "axe" && f.status === "incomplete");
  const keyboard = findings.filter((f) => f.source === "keyboard");
  const rules = countBy(violations.map((f) => f.ruleId));
  lines.push(`Baseline: ${s.violations} axe violations (${rules.length} rules), ${s.incomplete} needs-review, ${s.keyboard} keyboard findings`);
  if (rules.length) lines.push(`  ${rules.map(([r, n]) => `${r} ${n}`).join(" | ")}`);
  if (incomplete.length) lines.push(`  needs-review: ${incomplete.map((f) => `${f.ruleId} ${f.node.tag}`).join(" | ")}`);
  if (keyboard.length) lines.push(`  keyboard: ${keyboard.map((f) => `${f.ruleId} ${shortSelector(f.node.selector)}`).join(" | ")}`);
  const mapped = findings.filter((f) => !isUnmapped(f.location));
  const methods = countBy(mapped.map((f) => (isUnmapped(f.location) ? "" : f.location.method)));
  const unmapped = findings.length - mapped.length;
  lines.push(`Mapping: ${mapped.length} mapped${methods.length ? ` (${methods.map(([m, n]) => `${m} ${n}`).join(", ")})` : ""}, ${unmapped} unmapped`);
  lines.push("");

  const c = result.config;
  lines.push(`Fix loop (each candidate verified in a scratch copy, re-audited, judged on fingerprints; caps: ${c.maxCandidates} candidates, ${c.maxLlmCalls} LLM calls, ${Math.round(c.deadlineMs / 1000)} s)`);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const groups: Array<{ id: string; outcomes: FixOutcome[] }> = [];
  for (const o of result.outcomes) {
    const id = findingIdOf(o);
    const last = groups[groups.length - 1];
    if (last && last.id === id) last.outcomes.push(o);
    else groups.push({ id, outcomes: [o] });
  }
  const width = String(groups.length).length + 2;
  const widths: Widths = {
    rule: Math.max(...groups.map((g) => (byId.get(g.id)?.ruleId ?? g.id).length), 0) + 1,
    strategy: Math.max(...result.outcomes.map((o) => strategyOf(o).length), 0) + 1,
  };
  groups.forEach((g, i) => {
    g.outcomes.forEach((o, j) => {
      const prefix = j === 0 ? `[${i + 1}]`.padStart(width) : " ".repeat(width);
      lines.push(`${prefix} ${outcomeLine(byId.get(g.id), o, widths)}`);
    });
  });
  if (groups.length === 0) lines.push("  (no outcomes: --no-fix, or only needs-review items)");
  lines.push("");

  if (result.combined) {
    const r = result.combined.remaining;
    const rv = r.filter((f) => f.source === "axe" && f.status === "violation");
    const left = countBy(rv.map((f) => f.ruleId));
    const known = new Set(findings.map((f) => f.fingerprint));
    const fresh = r.filter((f) => !known.has(f.fingerprint)).length;
    const mismatches = result.warnings.filter((w) => w.startsWith("combined-audit-mismatch:")).length;
    lines.push(
      `Combined audit (${result.combined.included.length} accepted fixes merged, ${s.conflicts} conflicts): ${rv.length} axe violations remaining${left.length ? ` (${left.map(([rule, n]) => `${rule} ${n}`).join(", ")})` : ""}, ` +
        `${r.filter((f) => f.source === "axe" && f.status === "incomplete").length} needs-review, ${r.filter((f) => f.source === "keyboard").length} keyboard findings, ${fresh} new${mismatches ? `, ${mismatches} mismatches` : ""}`,
    );
  } else {
    lines.push("No fixes to apply.");
  }
  lines.push(totalsLine(result));
  lines.push(...screenReaderLines(result));
  lines.push(...writtenAndRemaining(result));
  const warnings = result.warnings.filter((w) => !w.startsWith("left-in-patch:"));
  if (warnings.length) lines.push(`Warnings: ${warnings.join(", ")}`);
  return lines.join("\n");
}

const IMPACTS = ["critical", "serious", "moderate", "minor"] as const;

/**
 * "Written: ..." after --write, then "Remaining in source: 3 serious (rule, rule), 1 moderate (rule). Fixable by
 * fixes.patch: N." (spec 5.9, 10.3). Only violations count: needs-review items never fail a build (P-2).
 */
export function writtenAndRemaining(result: AuditResult): string[] {
  const lines: string[] = [];
  if (result.written) {
    const left = result.summary.accepted - result.written.fixes.length;
    lines.push(
      result.written.files.length
        ? `Written: ${result.written.files.join(", ")} (${result.written.fixes.length} verified fix${result.written.fixes.length === 1 ? "" : "es"}; ${left} fix${left === 1 ? "" : "es"} left in fixes.patch${left ? ", need human review" : ""}).`
        : `Written: nothing (no verified fix to write; ${left} fix${left === 1 ? "" : "es"} left in fixes.patch).`,
    );
  }
  const violations = remainingFindings(result).filter((f) => f.status === "violation");
  const parts = IMPACTS.flatMap((impact) => {
    const own = violations.filter((f) => f.impact === impact);
    return own.length ? [`${own.length} ${impact} (${[...new Set(own.map((f) => f.ruleId))].join(", ")})`] : [];
  });
  lines.push(`Remaining in source: ${parts.length ? parts.join(", ") : "0 violations"}. Fixable by fixes.patch: ${result.summary.fixableByPatch}.`);
  return lines;
}

/** The --json line: the summary counters only. */
export function formatSummaryJson(result: AuditResult): string {
  return JSON.stringify(result.summary);
}
