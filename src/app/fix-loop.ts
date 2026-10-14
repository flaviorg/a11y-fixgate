// The fix loop (spec 5.6 "Outer loop", "Verification of one candidate", "Run limits"; P-3, P-15).
// Every candidate is built from the baseline text, gated, audited in its own scratch copy and judged.
import { createHash } from "node:crypto";
import type { AuditConfig } from "../contracts/config.ts";
import { isUnmapped } from "../contracts/finding.ts";
import type { Finding, SourceLocation } from "../contracts/finding.ts";
import type { FixCandidate, FixOutcome, FixPlan, FindingSet, NewFindingRef } from "../contracts/fix.ts";
import type { AuditResult } from "../contracts/result.ts";
import type { AuditProfile, AuditSnapshot } from "../contracts/snapshot.ts";
import { analyzeSnapshot, findingSetOf } from "../domain/findings.ts";
import { applyEdits, checkCandidate, toUnifiedDiff } from "../domain/fix/bounded-patch.ts";
import { strategiesFor } from "../domain/fix/catalog.ts";
import { createIdAllocator } from "../domain/fix/id-allocator.ts";
import type { FixContext, LlmStrategy, LlmStrategyRunner, Strategy, StrategyResult, SuggestReason } from "../domain/fix/types.ts";
import { buildHtmlIndex } from "../domain/map/html-index.ts";
import type { HtmlIndex } from "../domain/map/html-index.ts";
import type { AuditRunner, Clock, Logger, ScratchFactory, StaticServerFactory } from "../domain/ports.ts";
import { judge } from "../domain/verify/acceptance-gate.ts";
import { anchorOf, domKey } from "../domain/verify/fingerprint.ts";

export type FixLoopInput = {
  config: AuditConfig;
  baseline: AuditSnapshot;
  /** analyzeSnapshot(baseline), in document order (P-4). */
  findings: Finding[];
  /** Baseline text of every indexed page file, keyed by source-root-relative path. */
  baselineFiles: Record<string, string>;
  index: HtmlIndex;
  pageFile: string | null;
  profile: AuditProfile;
  /** Epoch milliseconds; checked before every candidate audit and every LLM call. */
  deadlineAt: number;
  /** Absolute paths left out of every scratch copy (P-10). */
  excludeAbs: string[];
};

export type FixLoopDeps = {
  runner: AuditRunner;
  servers: StaticServerFactory;
  scratch: ScratchFactory;
  clock: Clock;
  logger: Logger;
  llm: LlmStrategyRunner | null;
  catalog?: Record<string, Strategy[]>;
};

export type FixLoopResult = {
  outcomes: FixOutcome[];
  /** Accepted candidates in finding order (the input of combineEdits). */
  accepted: FixCandidate[];
  limits: AuditResult["limits"];
  llmCalls: number;
  llmUnavailable: boolean;
  /** The kind (timeout, server_error, ...) of the first provider failure that ended an LLM strategy; null otherwise. */
  llmUnavailableKind: string | null;
};

type Limit = "max-fixes" | "max-candidates" | "max-llm-calls" | "deadline";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The after snapshot's hash without the parts that vary between runs (url with its port, timings, screenshot path). */
function snapshotSha(snapshot: AuditSnapshot): string {
  const { url: _url, timings: _timings, screenshots: _screenshots, ...stable } = snapshot;
  return sha256(JSON.stringify(stable));
}

function emptyPlan(strategy: Pick<Strategy, "name" | "kind">, summary: string): FixPlan {
  return { strategy: strategy.name, kind: strategy.kind, edits: [], summary, needsHumanReview: false, reviewReason: null, generatedIds: [] };
}

/** The findings of `after` that the gate counts as new: new violations, new incomplete items and new keyboard findings. */
function newFindingsOf(after: Finding[], baseline: FindingSet): NewFindingRef[] {
  return after
    .filter((f) => (f.source === "keyboard" ? !baseline.keyboard.has(f.fingerprint) : f.status === "violation" ? !baseline.violations.has(f.fingerprint) : !baseline.incomplete.has(f.fingerprint)))
    .map((f) => ({ fingerprint: f.fingerprint, ruleId: f.ruleId, anchor: anchorOf(f.location, f.node) }));
}

/** Attempt 2's feedback after an acceptance rejection: "<reasons>: <new rule ids>", e.g. "new-violation: label-content-name-mismatch". */
export function acceptanceFeedback(reasons: string[], newFindings: NewFindingRef[]): string {
  const rules = [...new Set(newFindings.map((n) => n.ruleId))];
  return rules.length > 0 ? `${reasons.join(", ")}: ${rules.join(", ")}` : reasons.join(", ");
}

export async function runFixLoop(input: FixLoopInput, deps: FixLoopDeps): Promise<FixLoopResult> {
  const { config, baseline, findings, baselineFiles, index, pageFile, profile } = input;
  const { runner, servers, scratch, clock, logger, llm } = deps;
  const log = logger.child({ component: "loop" });
  const catalog = deps.catalog;
  const baselineSet = findingSetOf(findings);
  const fileIds = pageFile !== null && Object.hasOwn(index.files, pageFile) ? index.files[pageFile]!.ids : [];
  const ids = createIdAllocator(fileIds, baseline.domIds);

  const outcomes: FixOutcome[] = [];
  const accepted: FixCandidate[] = [];
  const limits = { candidatesUsed: 0, llmCallsUsed: 0, deadlineHit: false };
  let llmUnavailable = false;
  let llmUnavailableKind: string | null = null;
  const logged = new Set<Limit>();
  const limitValue: Record<Limit, number> = { "max-fixes": config.maxFixes, "max-candidates": config.maxCandidates, "max-llm-calls": config.maxLlmCalls, deadline: config.deadlineMs };

  /** Logs a cap once per kind and returns it. */
  const hit = (limit: Limit): Limit => {
    if (limit === "deadline") limits.deadlineHit = true;
    if (!logged.has(limit)) {
      logged.add(limit);
      log.warn("limit_hit", { limit, value: limitValue[limit] });
    }
    return limit;
  };
  const deadlinePassed = () => clock.now().getTime() >= input.deadlineAt;
  /** The cap that forbids one more candidate audit, or null. */
  const auditBlocked = (): Limit | null => {
    if (deadlinePassed()) return hit("deadline");
    if (accepted.length >= config.maxFixes) return hit("max-fixes");
    if (limits.candidatesUsed >= config.maxCandidates) return hit("max-candidates");
    return null;
  };
  /** The cap that forbids one more provider call, or null. */
  const llmBlocked = (): Limit | null => {
    if (deadlinePassed()) return hit("deadline");
    if (accepted.length >= config.maxFixes) return hit("max-fixes");
    if (limits.llmCallsUsed >= config.maxLlmCalls) return hit("max-llm-calls");
    return null;
  };

  type Verified = { kind: "accepted" | "rejected" | "gate-rejected"; feedback: string | null } | { kind: "blocked"; limit: Limit };

  /** Builds, gates, audits and judges one candidate; records its outcome. */
  const verify = async (finding: Finding, location: SourceLocation, plan: FixPlan, attempt: number): Promise<Verified> => {
    const file = plan.edits[0]?.range.file ?? location.file;
    const original = Object.hasOwn(baselineFiles, file) ? baselineFiles[file]! : null;
    let patched: string | null = null;
    let bounds: string | null = original === null ? "unknown-file" : plan.edits.length === 0 ? "no-edits" : null;
    let patch = "";
    if (bounds === null && original !== null) {
      try {
        patched = applyEdits(original, plan.edits);
        patch = toUnifiedDiff(file, original, patched);
        const checked = checkCandidate({ file, original, patched, patch, edits: plan.edits });
        if (!checked.ok) bounds = checked.reason;
      } catch {
        bounds = "edits-mismatch";
      }
    }
    if (bounds !== null || patched === null) {
      outcomes.push({ status: "gate-rejected", findingId: finding.id, strategy: plan.strategy, reason: "patch-out-of-bounds", proposal: plan.llm?.proposal ?? null });
      log.info("candidate_verdict", { findingId: finding.id, strategy: plan.strategy, attempt, status: "gate-rejected", reason: "patch-out-of-bounds", bounds });
      return { kind: "gate-rejected", feedback: "patch-out-of-bounds" };
    }

    const blocked = auditBlocked();
    if (blocked) return { kind: "blocked", limit: blocked };

    const candidate: FixCandidate = { findingId: finding.id, fingerprint: finding.fingerprint, plan, patch, patchedFiles: { [file]: patched }, patchSha256: sha256(patch) };
    limits.candidatesUsed++;
    const copy = await scratch.create(config.sourceRoot, { excludeAbs: input.excludeAbs });
    let after: AuditSnapshot;
    let afterFindings: Finding[];
    try {
      copy.write(candidate.patchedFiles);
      const server = await servers.start(copy.root);
      try {
        after = await runner.audit({ url: server.url + config.pagePath, servedRoot: copy.root, pagePath: config.pagePath, watch: [domKey(finding.node)] }, profile);
      } finally {
        await server.close();
      }
      afterFindings = analyzeSnapshot(after, buildHtmlIndex(copy.files()), pageFile, profile);
    } finally {
      copy.dispose();
    }

    const verdict = judge(baselineSet, findingSetOf(afterFindings), finding.fingerprint, { allowNewIncomplete: config.allowNewIncomplete });
    const afterSnapshotSha = snapshotSha(after);
    if (verdict.status === "accepted") {
      const verified = plan.needsHumanReview ? "verified-present-needs-review" : "verified";
      outcomes.push({ status: "accepted", verified, candidate, verdict, afterSnapshotSha });
      accepted.push(candidate);
      for (const id of plan.generatedIds) ids.reserve(id);
      log.info("candidate_verdict", { findingId: finding.id, strategy: plan.strategy, attempt, status: "accepted", verified, warnings: verdict.warnings });
      for (const w of verdict.warnings) if (w.startsWith("collateral-fix:")) log.warn("collateral_fix", { fingerprint: w.slice("collateral-fix:".length) });
      return { kind: "accepted", feedback: null };
    }
    const newFindings = newFindingsOf(afterFindings, baselineSet);
    outcomes.push({ status: "rejected", candidate, verdict, afterSnapshotSha, newFindings });
    log.info("candidate_verdict", { findingId: finding.id, strategy: plan.strategy, attempt, status: "rejected", reasons: verdict.reasons, new: newFindings });
    return { kind: "rejected", feedback: acceptanceFeedback(verdict.status === "rejected" ? verdict.reasons : [], newFindings) };
  };

  type StrategyEnd = { done: boolean; skipped?: Limit };

  const suggest = (finding: Finding, plan: FixPlan, reason: SuggestReason): StrategyEnd => {
    outcomes.push({ status: "suggest-only", findingId: finding.id, plan, reason });
    return { done: true };
  };

  /** A plan or suggestion from a deterministic strategy or an LLM result. */
  const settle = async (finding: Finding, location: SourceLocation, result: StrategyResult, attempt: number): Promise<{ end: StrategyEnd | null; feedback: string | null }> => {
    if (result.type === "skip") return { end: { done: false }, feedback: null };
    if (result.type === "suggest") return { end: suggest(finding, result.plan, result.reason), feedback: null };
    const v = await verify(finding, location, result.plan, attempt);
    if (v.kind === "blocked") return { end: { done: true, skipped: v.limit }, feedback: null };
    if (v.kind === "accepted") return { end: { done: true }, feedback: null };
    return { end: null, feedback: v.feedback };
  };

  /**
   * At most 2 attempts per LLM strategy (spec 5.6 "Outer loop", LLM-02). Attempt 2 follows a value-gate
   * rejection (not audited) or an acceptance rejection (audited), with the rejection as feedback. Two value
   * or schema failures end as gate-rejected: llm-invalid; a second acceptance rejection stays rejected. An
   * unavailable provider is retried once; when the last attempt is unavailable the strategy ends as
   * gate-rejected: llm-unavailable and the circuit breaker answers every later LLM strategy without a call.
   */
  const runLlm = async (finding: Finding, location: SourceLocation, strategy: LlmStrategy, ctx: FixContext): Promise<StrategyEnd> => {
    if (llm === null) return suggest(finding, emptyPlan(strategy, `${strategy.task}: run with a provider to get a proposal`), "llm-disabled");
    let feedback: string | null = null;
    let valueFailures = 0;
    for (const attempt of [1, 2] as const) {
      if (llmUnavailable) {
        outcomes.push({ status: "gate-rejected", findingId: finding.id, strategy: strategy.name, reason: "llm-unavailable", proposal: null });
        return { done: false };
      }
      const blocked = llmBlocked();
      if (blocked) return { done: true, skipped: blocked };
      limits.llmCallsUsed++;
      const proposal = await llm.propose({ strategy, ctx, attempt, feedback });
      if (proposal.type === "unavailable") {
        if (attempt === 1) continue;
        llmUnavailable = true;
        llmUnavailableKind = proposal.kind;
        outcomes.push({ status: "gate-rejected", findingId: finding.id, strategy: strategy.name, reason: "llm-unavailable", proposal: null });
        log.warn("llm_unavailable", { findingId: finding.id, strategy: strategy.name, attempt });
        return { done: false };
      }
      if (proposal.type === "no-proposal") return suggest(finding, emptyPlan(strategy, `${strategy.task}: no proposal (${proposal.reason})`), proposal.reason);
      if (proposal.type === "gate-rejected") {
        valueFailures++;
        const reason = valueFailures === 2 ? "llm-invalid" : proposal.reason;
        outcomes.push({ status: "gate-rejected", findingId: finding.id, strategy: strategy.name, reason, proposal: proposal.proposal });
        log.info("candidate_verdict", { findingId: finding.id, strategy: strategy.name, attempt, status: "gate-rejected", reason, gate: proposal.reason });
        feedback = proposal.reason;
        continue;
      }
      const settled = await settle(finding, location, proposal.result, attempt);
      if (settled.end) return settled.end;
      feedback = settled.feedback;
    }
    return { done: false };
  };

  for (const finding of findings) {
    // P-3: axe "needs review" items are reported, never fixed.
    if (finding.source === "axe" && finding.status === "incomplete") continue;
    if (isUnmapped(finding.location)) {
      outcomes.push({ status: "unmapped", findingId: finding.id, reason: finding.location.reason });
      continue;
    }
    const location = finding.location;
    const strategies = strategiesFor(finding.ruleId, catalog);
    const ctx: FixContext = {
      finding,
      location,
      source: baselineFiles[location.file] ?? "",
      index,
      snapshot: baseline,
      config: { lang: config.lang, allowNewIncomplete: config.allowNewIncomplete },
      ids,
    };
    // P-3: keyboard findings are always suggestions; without a catalog entry the check's own message is the advice.
    if (finding.source === "keyboard" && !strategies.some((s) => s.kind === "suggest-only")) {
      suggest(finding, emptyPlan({ name: `${finding.ruleId}-advice`, kind: "suggest-only" }, finding.message), "catalog");
      continue;
    }

    const before = outcomes.length;
    let end: StrategyEnd = { done: false };
    for (const strategy of strategies) {
      if (strategy.kind === "suggest-only") end = suggest(finding, emptyPlan(strategy, strategy.suggest(ctx)), "catalog");
      else if (strategy.kind === "llm") end = await runLlm(finding, location, strategy, ctx);
      else {
        const settled = await settle(finding, location, strategy.run(ctx), 1);
        end = settled.end ?? { done: false };
      }
      if (end.done) break;
    }
    if (end.skipped) outcomes.push({ status: "skipped", findingId: finding.id, reason: end.skipped });
    else if (outcomes.length === before) outcomes.push({ status: "skipped", findingId: finding.id, reason: "no-strategy" });
  }

  return { outcomes, accepted, limits, llmCalls: limits.llmCallsUsed, llmUnavailable, llmUnavailableKind };
}
