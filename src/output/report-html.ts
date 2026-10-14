// The HTML report (spec 5.8 row report.html; OUT-01, OUT-06, OUT-07, RF-1).
// One file, inline CSS, no script and a Content-Security-Policy with no script source. Every value enters the
// page through html`...` (src/output/escape.ts), and the whole output goes through redactText. The report must
// pass the tool's own audit (CS-6): landmarks, one h1, ordered headings, contrast, focusable scroll regions.
import { diffLines } from "diff";
import { isUnmapped } from "../contracts/finding.ts";
import type { Finding } from "../contracts/finding.ts";
import type { FixOutcome, FixPlan } from "../contracts/fix.ts";
import type { AuditResult } from "../contracts/result.ts";
import { DEFAULT_PROFILE } from "../contracts/snapshot.ts";
import type { AuditSnapshot } from "../contracts/snapshot.ts";
import { TOOL } from "../contracts/tool.ts";
import { remainingFindings } from "../domain/findings.ts";
import { PERSONAS } from "../domain/personas/catalog.ts";
import type { Persona } from "../domain/personas/catalog.ts";
import { blockedTable, entryFor, impactFor, topImpacts } from "../domain/personas/impact.ts";
import { domKey } from "../domain/verify/fingerprint.ts";
import { redactText } from "../infra/redact.ts";
import { html, raw } from "./escape.ts";
import type { Raw } from "./escape.ts";

// img-src allows data: for the inline icon declared in the head (<link rel="icon" href="data:,">). Without an icon, a full
// Chromium asks the server for /favicon.ico by itself; a static server answers 404 and the console shows an error.
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #ffffff; color: #1b1f24; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: #0a4cb8; }
a:focus-visible, summary:focus-visible, pre:focus-visible { outline: 3px solid #0a4cb8; outline-offset: 2px; }
.skip { position: absolute; left: -9999px; top: 8px; background: #0a4cb8; color: #ffffff; padding: 8px 14px; border-radius: 4px; z-index: 10; }
.skip:focus { left: 8px; }
header.top, main, footer { max-width: 62rem; margin: 0 auto; padding: 0 16px; }
header.top { padding-top: 24px; padding-bottom: 8px; border-bottom: 1px solid #c5ccd6; }
header.top p { margin: 4px 0; color: #3f4854; }
h1 { font-size: 1.9rem; margin: 0 0 8px; }
h2 { font-size: 1.4rem; margin: 32px 0 8px; padding-top: 8px; border-top: 1px solid #c5ccd6; }
h3 { font-size: 1.1rem; margin: 20px 0 6px; }
h4 { font-size: 1rem; margin: 0 0 6px; }
nav ul { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
nav a { display: inline-block; padding: 4px 10px; min-height: 28px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
caption { text-align: left; font-weight: 600; padding: 4px 0; }
th, td { border: 1px solid #c5ccd6; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #eef1f5; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; overflow-wrap: anywhere; }
pre { margin: 8px 0; padding: 10px; background: #f3f5f8; border: 1px solid #c5ccd6; border-radius: 4px; overflow-x: auto; max-width: 100%; font: 0.85rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
.add { background: #d4f1dc; display: inline-block; min-width: 100%; }
.del { background: #fbd8dc; display: inline-block; min-width: 100%; }
.hunk { background: #e1e6ed; display: inline-block; min-width: 100%; }
.card { border: 1px solid #c5ccd6; border-radius: 6px; padding: 12px; margin: 10px 0; background: #fafbfc; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.85rem; margin: 0 4px 4px 0; border: 1px solid transparent; }
.ok { background: #d4f1dc; color: #0d4a22; border-color: #8bcf9f; }
.review { background: #fff0c2; color: #5a3d00; border-color: #e0bd52; }
.bad { background: #fbd8dc; color: #7a1420; border-color: #e19aa3; }
.neutral { background: #e4e8ee; color: #26303b; border-color: #b3bcc9; }
.muted { color: #3f4854; }
.finding { margin-bottom: 24px; }
ul.plain { padding-left: 20px; }
img { max-width: 100%; height: auto; border: 1px solid #c5ccd6; }
details { margin: 8px 0; }
summary { cursor: pointer; padding: 4px 0; min-height: 28px; }
footer { padding-top: 16px; padding-bottom: 32px; color: #3f4854; border-top: 1px solid #c5ccd6; margin-top: 32px; }
`;

const PERSONA_LABEL: Record<Persona, string> = { "screen-reader": "Screen reader user", "keyboard-only": "Keyboard-only user", "low-vision": "Low-vision user", cognitive: "Cognitive-access user" };
const HOST_NOTE = "Persona severities are the project's own rating (0 none, 1 friction, 2 major, 3 blocker), not a measurement.";

const findingIdOf = (o: FixOutcome): string => ("candidate" in o ? o.candidate.findingId : o.findingId);

function locationOf(f: Finding): string {
  return isUnmapped(f.location) ? `not mapped to the source (${f.location.reason})` : `${f.location.file}:${f.location.startLine}:${f.location.startCol}`;
}

/** The tags of each rule in the snapshots, for the cat.* persona fallbacks. */
function tagsByRule(result: AuditResult): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const snaps: AuditSnapshot[] = [result.baseline, ...(result.combined ? [result.combined.snapshot] : [])];
  for (const s of snaps) for (const r of [...s.axe.violations, ...s.axe.incomplete]) out[r.id] ??= r.tags;
  return out;
}

function badge(kind: "ok" | "review" | "bad" | "neutral", text: string): Raw {
  return html`<span class="badge ${kind}">${text}</span>`;
}

function kindBadges(plan: FixPlan): Raw {
  const badges: Raw[] = [];
  if (plan.kind === "llm") badges.push(badge("review", "LLM (needs human review)"));
  else if (plan.reviewReason === "inferred-lang") badges.push(badge("review", "inferred (needs human review)"));
  else if (plan.kind === "suggest-only") badges.push(badge("neutral", "suggestion only"));
  else badges.push(badge("neutral", "deterministic"));
  if (plan.reviewReason === "design-review") badges.push(badge("review", "design review (needs human review)"));
  return html`${badges}`;
}

function verifiedLabel(o: Extract<FixOutcome, { status: "accepted" }>): string {
  if (o.verified === "verified") return "Verified";
  return o.candidate.plan.reviewReason === "design-review" ? "Verified present, design review" : "Verified present, needs review";
}

/** A <pre> that scrolls sideways: focusable and named, so the tool's own scrollable-region-focusable check passes. */
function pre(label: string, body: Raw | string): Raw {
  return html`<pre role="group" tabindex="0" aria-label="${label}">${body}</pre>`;
}

/** The unified diff of a candidate, one coloured span per line. The leading "====" line of createTwoFilesPatch is dropped. */
function diffBlock(label: string, patch: string): Raw {
  const lines = patch.replace(/\r?\n$/, "").split(/\r?\n/).filter((l, i) => !(i === 0 && /^=+$/.test(l)));
  const spans = lines.map((l) => {
    const cls = l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
    return cls ? html`<span class="${cls}">${l}</span>\n` : html`${l}\n`;
  });
  return pre(label, html`${spans}`);
}

/** The screen reader view diff: baseline.ariaByNode[k] against combined.snapshot.ariaByNode[k] as "- ", "+ " and "  " lines. */
function screenReaderView(result: AuditResult, f: Finding): Raw {
  if (f.node.domTagIndex < 0 || !result.combined) return html``;
  const key = domKey(f.node);
  const before = result.baseline.ariaByNode[key];
  const after = result.combined.snapshot.ariaByNode[key];
  if (before === undefined || after === undefined) return html``;
  const label = `Screen reader view of ${f.id} (${key}), before and after the combined fixes`;
  if (before === after) return html`<p class="muted">Screen reader view of <code>${key}</code>: unchanged by the combined fixes.</p>`;
  const lines: Raw[] = [];
  for (const part of diffLines(before, after)) {
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    const cls = part.added ? "add" : part.removed ? "del" : "";
    for (const l of part.value.replace(/\n$/, "").split("\n")) lines.push(cls ? html`<span class="${cls}">${prefix}${l}</span>\n` : html`${prefix}${l}\n`);
  }
  return html`<p><strong>Screen reader view</strong> of <code>${key}</code> (accessibility tree of that element before and after the combined fixes; <code>-</code> removed, <code>+</code> added):</p>${pre(label, html`${lines}`)}`;
}

function personaList(f: Finding, tags: Record<string, string[]>): Raw {
  const ruleTags = tags[f.ruleId] ?? [];
  const top = topImpacts(impactFor(f, ruleTags), 2);
  const entry = entryFor(f, ruleTags);
  if (top.length === 0) return html`<p class="muted">No persona is rated above 0 for this rule (project rating).</p>`;
  return html`<ul class="plain">${top.map((i) => html`<li><strong>${PERSONA_LABEL[i.persona]}</strong>, severity ${i.severity} of 3 (project rating): ${i.text}.</li>`)}</ul><p class="muted">Basis: <a href="${entry.basis}">WCAG 2.2 Understanding page for ${entry.wcag.join(", ") || entry.rule}</a>.</p>`;
}

/** What a model proposed: the value, its kind and its reason (all escaped by html``). */
function proposalBlock(proposal: unknown): Raw {
  if (proposal === null || typeof proposal !== "object") return html``;
  const p = proposal as Record<string, unknown>;
  const value = typeof p["alt"] === "string" ? p["alt"] : typeof p["name"] === "string" ? p["name"] : null;
  const kind = typeof p["kind"] === "string" ? p["kind"] : null;
  const reason = typeof p["reason"] === "string" ? p["reason"] : null;
  return html`<ul class="plain">${kind !== null ? html`<li>Model kind: <code>${kind}</code></li>` : ""}${value !== null ? html`<li>Proposed value: <code>${value}</code></li>` : ""}${reason !== null ? html`<li>Model reason: ${reason}</li>` : ""}</ul>`;
}

function newFindingsList(o: Extract<FixOutcome, { status: "rejected" }>): Raw {
  if (o.newFindings.length === 0) return html``;
  return html`<p>New findings that the re-audit introduced:</p><ul class="plain">${o.newFindings.map((n) => html`<li><code>${n.ruleId}</code> at <code>${n.anchor}</code> (fingerprint <code>${n.fingerprint}</code>)</li>`)}</ul>`;
}

function cardFor(result: AuditResult, o: FixOutcome, f: Finding, n: number, total: number): Raw {
  const suffix = total > 1 ? ` (candidate ${n} of ${total})` : "";
  const included = result.combined?.included.includes(findingIdOf(o)) ?? false;
  const written = result.written?.fixes.includes(findingIdOf(o)) ?? false;
  switch (o.status) {
    case "accepted": {
      const p = o.candidate.plan;
      const attempt = p.llm && p.llm.attempt > 1 ? `, attempt ${p.llm.attempt}` : "";
      return html`<article class="card" data-outcome="accepted"><h4>ACCEPTED: ${p.strategy}${attempt}</h4>
<p>${badge("ok", "accepted")}${badge(o.verified === "verified" ? "ok" : "review", verifiedLabel(o))}${kindBadges(p)}</p>
<p>${p.summary}</p>
<p>Verdict: the target finding is gone and no new finding appeared in the re-audit.${o.verdict.status === "accepted" && o.verdict.warnings.length ? html` Warnings: ${o.verdict.warnings.join(", ")}.` : ""} ${written ? "Written to the source." : included ? "Included in fixes.patch." : "Not included in the combined patch."}</p>
${p.llm ? html`<p class="muted">LLM request <code>${p.llm.requestId}</code>, gate passed.</p>${proposalBlock(p.llm.proposal)}` : ""}
${diffBlock(`Source diff for ${f.id}${suffix}`, o.candidate.patch)}</article>`;
    }
    case "rejected": {
      const p = o.candidate.plan;
      const reasons = o.verdict.status === "rejected" ? o.verdict.reasons : [];
      const attempt = p.llm && p.llm.attempt > 1 ? `, attempt ${p.llm.attempt}` : "";
      return html`<article class="card" data-outcome="rejected"><h4>REJECTED: ${p.strategy}${attempt}</h4>
<p>${badge("bad", "rejected")}${kindBadges(p)}</p>
<p>${p.summary}</p>
<p>Verdict: <strong>${reasons.join(", ") || "rejected"}</strong>${o.verdict.status === "rejected" && o.verdict.targetGone ? " (the target finding was gone, but the fix is rejected because of what it introduced)" : ""}. The candidate was applied to a scratch copy and re-audited in the browser; it is not part of fixes.patch.</p>
${newFindingsList(o)}
${p.llm ? html`<p class="muted">LLM request <code>${p.llm.requestId}</code>, passed the value gates.</p>${proposalBlock(p.llm.proposal)}` : ""}
${diffBlock(`Source diff for ${f.id}${suffix}`, o.candidate.patch)}</article>`;
    }
    case "gate-rejected":
      return html`<article class="card" data-outcome="gate-rejected"><h4>GATE-REJECTED: ${o.strategy}</h4>
<p>${badge("bad", "gate-rejected")}${o.strategy.endsWith("-llm") ? badge("review", "LLM (needs human review)") : badge("neutral", "deterministic")}</p>
<p>Reason: <code>${o.reason}</code>. The value was refused before any audit; nothing was applied.</p>
${proposalBlock(o.proposal)}</article>`;
    case "conflict":
      return html`<article class="card" data-outcome="conflict"><h4>CONFLICT</h4>
<p>${badge("bad", "conflict")}</p>
<p>The accepted fix for ${f.id} overlaps another accepted fix (<code>${o.with}</code>, ${o.reason}) and was left out of the combined patch.</p></article>`;
    case "skipped":
      return html`<article class="card" data-outcome="skipped"><h4>SKIPPED</h4>
<p>${badge("neutral", "skipped")}</p>
<p>Reason: <code>${o.reason}</code>.</p></article>`;
    case "suggest-only": {
      const p = o.plan;
      return html`<article class="card" data-outcome="suggest-only"><h4>SUGGESTION: ${p.strategy}</h4>
<p>${badge("neutral", "suggestion only")}${p.kind === "suggest-only" && p.llm ? badge("review", "LLM (needs human review)") : ""}<code>${o.reason}</code></p>
<p>${p.summary}</p>
${p.llm ? proposalBlock(p.llm.proposal) : ""}</article>`;
    }
    case "unmapped":
      return html`<article class="card" data-outcome="unmapped"><h4>UNMAPPED</h4>
<p>${badge("neutral", "no patch")}<code>${o.reason}</code></p>
<p>This finding could not be tied to one place in the source, so no patch was built.</p></article>`;
  }
}

function findingHeader(f: Finding): Raw {
  return html`<p>${badge(f.impact === "critical" || f.impact === "serious" ? "bad" : "neutral", f.impact)}${badge("neutral", f.status === "incomplete" ? "needs review" : "violation")}<code>${f.ruleId}</code>, ${f.help}</p>
<p class="muted">Location: <code>${locationOf(f)}</code>. Element: <code>${f.node.htmlSnippet}</code></p>
${f.message.trim() ? html`<p class="muted">Check result: ${f.message.replace(/\s+/g, " ").trim().slice(0, 400)}</p>` : ""}`;
}

/** One block per finding that has outcomes in the given statuses: header, persona impacts, screen reader view and one card per outcome. */
function findingBlocks(result: AuditResult, statuses: ReadonlySet<FixOutcome["status"]>, tags: Record<string, string[]>): Raw {
  const blocks: Raw[] = [];
  for (const f of result.findings) {
    const own = result.outcomes.filter((o) => findingIdOf(o) === f.id);
    const mine = own.filter((o) => statuses.has(o.status));
    if (mine.length === 0) continue;
    blocks.push(html`<div class="finding" id="fix-${f.id}"><h3>${f.id}: ${f.help}</h3>
${findingHeader(f)}
${personaList(f, tags)}
${mine.some((o) => o.status === "accepted" || o.status === "rejected") ? screenReaderView(result, f) : ""}
${mine.map((o, i) => cardFor(result, o, f, i + 1, mine.length))}</div>`);
  }
  return html`${blocks}`;
}

function statusRow(label: string, meaning: string, count: number): Raw {
  return html`<tr><th scope="row">${label}</th><td>${meaning}</td><td>${count}</td></tr>`;
}

function whoIsBlocked(result: AuditResult, tags: Record<string, string[]>): Raw {
  const before = blockedTable(result.findings, tags);
  const afterFindings = result.combined ? result.combined.remaining : result.findings;
  const after = blockedTable(afterFindings, tags);
  return html`<h3>Who is blocked</h3>
<table><caption>Findings that block each kind of user (severity 3, project rating): in the files now, and after the combined fixes.</caption>
<thead><tr><th scope="col">User</th><th scope="col">Before the fixes</th><th scope="col">After the combined fixes</th></tr></thead>
<tbody>${PERSONAS.map((p) => html`<tr><th scope="row">${PERSONA_LABEL[p]}</th><td>${before[p]}</td><td>${after[p]}</td></tr>`)}</tbody></table>
<p class="muted">${HOST_NOTE}</p>`;
}

function summarySection(result: AuditResult, tags: Record<string, string[]>): Raw {
  const s = result.summary;
  const remaining = remainingFindings(result);
  const remainingViolations = remaining.filter((f) => f.status === "violation");
  const bySeverity = (["critical", "serious", "moderate", "minor"] as const).map((i) => [i, remainingViolations.filter((f) => f.impact === i).length] as const).filter(([, n]) => n > 0);
  const shots = html`${result.baseline.screenshots.fullPage !== "" ? html`<figure><img src="${result.baseline.screenshots.fullPage}" alt="Full page before fixes"><figcaption class="muted">Before the fixes</figcaption></figure>` : ""}${result.combined && result.combined.snapshot.screenshots.fullPage !== "" ? html`<figure><img src="${result.combined.snapshot.screenshots.fullPage}" alt="Full page after the combined fixes"><figcaption class="muted">After the combined fixes</figcaption></figure>` : ""}`;
  return html`<section aria-labelledby="h-summary"><h2 id="h-summary">Summary</h2>
<table><caption>What the audit found on ${result.baseline.pagePath}</caption>
<thead><tr><th scope="col">Item</th><th scope="col">Count</th></tr></thead><tbody>
<tr><th scope="row">axe violations</th><td>${s.violations}</td></tr>
<tr><th scope="row">axe needs-review items (not fixed)</th><td>${s.incomplete}</td></tr>
<tr><th scope="row">Keyboard findings</th><td>${s.keyboard}</td></tr>
<tr><th scope="row">Findings mapped to the source</th><td>${result.findings.filter((f) => !isUnmapped(f.location)).length}</td></tr>
<tr><th scope="row">Findings not mapped</th><td>${result.findings.filter((f) => isUnmapped(f.location)).length}</td></tr>
</tbody></table>
<table><caption>How each fix was verified (re-audited in a real browser; the target finding is gone and no new axe or keyboard finding appeared)</caption>
<thead><tr><th scope="col">Status</th><th scope="col">Meaning</th><th scope="col">Count</th></tr></thead><tbody>
${statusRow("Verified", "A deterministic fix. The browser shows the finding gone and nothing new.", s.verified)}
${statusRow("Verified present, needs review", "A value written by a model, a colour change or an inferred language. Its presence is verified; its meaning is not.", s.verifiedNeedsReview)}
${statusRow("Rejected", "The re-audit found a new finding, or the target stayed.", s.rejected)}
${statusRow("Gate-rejected", "A proposed value failed a value gate before any audit.", s.gateRejected)}
${statusRow("Suggestions only", "Findings that no fixer can change safely.", s.suggestOnly)}
${statusRow("Unmapped", "Findings that could not be tied to one place in the source.", s.unmapped)}
${statusRow("Conflicts", "Accepted fixes left out because they overlap another.", s.conflicts)}
${statusRow("Skipped", "Findings not attempted because of a limit or because no strategy exists.", s.skipped)}
</tbody></table>
<ul class="plain">
<li>Accepted fixes: ${s.accepted}.</li>
<li>Needs human review: ${s.verifiedNeedsReview} (accepted fixes whose text or colour a person must confirm).</li>
<li>Needs review, not fixed: ${s.incomplete} (axe could not decide; listed below).</li>
<li>Remaining in source: ${remainingViolations.length} violation(s)${bySeverity.length ? html` (${bySeverity.map(([i, n]) => `${n} ${i}`).join(", ")})` : ""}; fixable by fixes.patch: ${s.fixableByPatch}.</li>
${result.written ? html`<li>Written to the source: ${result.written.files.length ? result.written.files.join(", ") : "nothing"} (${result.written.fixes.length} verified fix(es)). The remaining accepted fixes stayed in fixes.patch because they need human review.</li>` : ""}
</ul>
${result.warnings.length ? html`<p><strong>Warnings:</strong></p><ul class="plain">${result.warnings.map((w) => html`<li><code>${w}</code></li>`)}</ul>` : ""}
${whoIsBlocked(result, tags)}
${shots}</section>`;
}

function needsReviewSection(result: AuditResult, tags: Record<string, string[]>): Raw {
  const items = result.findings.filter((f) => f.source === "axe" && f.status === "incomplete");
  return html`<section aria-labelledby="h-review"><h2 id="h-review">Needs review (not fixed)</h2>
<p>axe could not decide these items automatically. They are listed for a person to check; no fix was tried.</p>
${items.length === 0 ? html`<p>None.</p>` : html`<ul class="plain">${items.map((f) => html`<li id="review-${f.id}"><strong>${f.id}</strong> (<code>${f.ruleId}</code>, ${f.impact}), <code>${locationOf(f)}</code>: ${f.help}. <code>${f.node.htmlSnippet}</code> ${personaList(f, tags)}</li>`)}</ul>`}</section>`;
}

function unmappedSection(result: AuditResult): Raw {
  const unmapped = result.findings.filter((f) => isUnmapped(f.location));
  return html`<section aria-labelledby="h-unmapped"><h2 id="h-unmapped">Unmapped</h2>
<p>These findings exist in the live page but could not be tied to one element in the source (for example an element added by a script), so no patch was built. A build that renders templates can opt in by adding <code>data-a11y-source="&lt;file&gt;:&lt;line&gt;:&lt;column&gt;"</code> to the start tag, giving the position of its opening angle bracket in the source.</p>
${unmapped.length === 0 ? html`<p>None.</p>` : unmapped.map((f) => {
    const outcome = result.outcomes.find((o) => o.status === "unmapped" && o.findingId === f.id);
    return html`<div class="finding" id="unmapped-${f.id}"><h3>${f.id}: ${f.help}</h3>${findingHeader(f)}${outcome ? cardFor(result, outcome, f, 1, 1) : ""}</div>`;
  })}</section>`;
}

function keyboardTrace(result: AuditResult): Raw {
  const t = result.baseline.traversal;
  return html`<section aria-labelledby="h-keyboard"><h2 id="h-keyboard">Keyboard trace</h2>
<details><summary>Tab order walked by the audit (${t.steps.length} steps, stopped because: ${t.stoppedBecause})</summary>
<table><caption>Focus order. Covered points: how many of 5 sampled points of the focused element showed another element.</caption>
<thead><tr><th scope="col">Step</th><th scope="col">Element</th><th scope="col">Covered points</th><th scope="col">Covered by</th><th scope="col">Host</th></tr></thead>
<tbody>${t.steps.map((s) => html`<tr><td>${s.index}</td><td><code>${s.selector}</code></td><td>${s.coveredPoints} of 5</td><td>${s.coveredBy ?? ""}</td><td>${s.hostKind}</td></tr>`)}</tbody></table>
${t.interactiveCandidates.length ? html`<table><caption>Elements that look interactive without being native controls</caption>
<thead><tr><th scope="col">Element</th><th scope="col">Why it looks interactive</th><th scope="col">Focusable</th><th scope="col">Reached by Tab</th></tr></thead>
<tbody>${t.interactiveCandidates.map((c) => html`<tr><td><code>${c.selector}</code></td><td>${c.reason}</td><td>${c.focusable ? "yes" : "no"}</td><td>${c.reached ? "yes" : "no"}</td></tr>`)}</tbody></table>` : ""}
</details></section>`;
}

function methodology(result: AuditResult): Raw {
  const tags = (result.baseline.axe.toolOptions as { runOnly?: { values?: unknown } } | null)?.runOnly?.values;
  const tagList = Array.isArray(tags) ? tags.map(String) : DEFAULT_PROFILE.axeTags;
  return html`<section aria-labelledby="h-method"><h2 id="h-method">Methodology</h2>
<ul class="plain">
<li>Engine: axe-core ${result.baseline.axeVersion} with the tags ${tagList.join(", ")}, plus three keyboard checks run in a real Chromium.</li>
<li>Deterministic: the audit, the source mapping, the edits, the bounds check, the acceptance gate (fingerprints before and after), the combine and every output file.</li>
<li>LLM: ${result.llm.provider === "none" ? "not used in this run." : `the ${result.llm.provider} provider (${result.llm.calls} call(s), prompt ${result.llm.promptVersion}) proposes a value only (alternative text or a control name). It never writes a diff, runs a gate or decides. Every such value is marked for human review.`}</li>
<li>Heuristic: the keyboard checks. A trap or an obscured focus is reported as needs review, not as a failure.</li>
<li>Persona severities are a project rating from 0 to 3 taken from a fixed catalog, not a measurement. Each card links the WCAG 2.2 Understanding page that names who benefits.</li>
<li>Contrast fixes change the HSL lightness of one colour in an inline style until the ratio is met. They keep hue and saturation but do not know the design, so they are always marked for design review.</li>
<li>Verified means: re-audited in a real browser; the target failure is gone and no new axe or keyboard finding (violation or needs-review) appeared. It does not see layout, script errors or meaning; LLM-written text is marked for human review.</li>
</ul></section>`;
}

function standardsNote(): Raw {
  return html`<section aria-labelledby="h-standards"><h2 id="h-standards">Standards note</h2>
<ul class="plain">
<li>This tool helps find and fix common WCAG 2.2 AA failures. It is not a conformance audit and not legal advice.</li>
<li>These are failures detected by automated checks; real barriers are more numerous.</li>
<li>WCAG 2.2 is a W3C Recommendation (first published 5 October 2023). 4.1.1 Parsing was removed. Of the new AA criteria, this tool checks 2.5.8 Target Size via axe and approximates 2.4.11 Focus Not Obscured with a heuristic; it does not check 2.5.7, 3.2.6, 3.3.7 or 3.3.8. See <a href="https://www.w3.org/TR/WCAG22/">the WCAG 2.2 Recommendation</a>.</li>
</ul></section>`;
}

function emptyBody(result: AuditResult): Raw {
  return html`<section aria-labelledby="h-summary"><h2 id="h-summary">Summary</h2>
<p><strong>No findings.</strong> axe and the keyboard checks found nothing on ${result.baseline.pagePath}. No fixes to apply.</p>
<p class="muted">An empty result is not proof of conformance: automated checks find only part of the barriers a person meets.</p></section>`;
}

/** The whole report as one HTML string. */
export function renderReport(result: AuditResult): string {
  const tags = tagsByRule(result);
  const empty = result.findings.length === 0;
  const fixable = new Set<FixOutcome["status"]>(["accepted", "rejected", "gate-rejected", "conflict", "skipped"]);
  const body = empty
    ? html`${emptyBody(result)}${methodology(result)}${standardsNote()}`
    : html`${summarySection(result, tags)}
<section aria-labelledby="h-fixes"><h2 id="h-fixes">Fixes</h2>
<p>Each card is one attempt. A candidate edit is applied to a scratch copy, the page is re-audited in the browser, and the acceptance gate compares fingerprints before and after.</p>
${findingBlocks(result, fixable, tags)}</section>
<section aria-labelledby="h-suggestions"><h2 id="h-suggestions">Suggestions</h2>
<p>Findings that no fixer can change safely. Each says what a person should do.</p>
${findingBlocks(result, new Set<FixOutcome["status"]>(["suggest-only"]), tags)}</section>
${needsReviewSection(result, tags)}
${unmappedSection(result)}
${keyboardTrace(result)}
${methodology(result)}
${standardsNote()}`;
  const nav = empty
    ? []
    : [["h-summary", "Summary"], ["h-fixes", "Fixes"], ["h-suggestions", "Suggestions"], ["h-review", "Needs review"], ["h-unmapped", "Unmapped"], ["h-keyboard", "Keyboard trace"], ["h-method", "Methodology"], ["h-standards", "Standards note"]] as const;
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${raw(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)}
<link rel="icon" href="data:,">
<title>${TOOL.name} report: ${result.baseline.pagePath}</title>
<style>${raw(CSS)}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the report</a>
<header class="top">
<h1>Accessibility fix report</h1>
<p>Page <code>${result.baseline.pagePath}</code>, audited with axe-core ${result.baseline.axeVersion} and three keyboard checks. ${result.summary.violations} violation(s), ${result.summary.incomplete} needs-review, ${result.summary.keyboard} keyboard finding(s).</p>
${nav.length ? html`<nav aria-label="Report sections"><ul>${nav.map(([id, label]) => html`<li><a href="#${id}">${label}</a></li>`)}</ul></nav>` : ""}
</header>
<main id="main">
${body}
</main>
<footer>
<p>Generated by ${TOOL.name} ${TOOL.version}. Every value on this page is escaped and the page carries no script.</p>
</footer>
</body>
</html>
`;
  return redactText(page.html);
}
