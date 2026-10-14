// The run orchestrator (spec 4.4, 5.6, 5.8; plan Task 20): baseline audit on a scratch copy, mapping,
// the fix loop, the edit-level combine and one combined audit.
import { resolve } from "node:path";
import type { AuditConfig } from "../contracts/config.ts";
import { isUnmapped } from "../contracts/finding.ts";
import type { Finding } from "../contracts/finding.ts";
import type { FixOutcome } from "../contracts/fix.ts";
import type { AuditResult, Summary } from "../contracts/result.ts";
import { DEFAULT_PROFILE } from "../contracts/snapshot.ts";
import type { AuditProfile, AuditSnapshot } from "../contracts/snapshot.ts";
import { analyzeSnapshot, findingSetOf } from "../domain/findings.ts";
import type { LlmStrategyRunner, Strategy } from "../domain/fix/types.ts";
import { buildHtmlIndex } from "../domain/map/html-index.ts";
import { pageFileFor } from "../domain/map/page-file.ts";
import type { AuditOptions, AuditRunner, AuditTarget, Clock, Logger, ScratchFactory, StaticServerFactory } from "../domain/ports.ts";
import { combineEdits } from "../domain/verify/combine.ts";
import { domKey } from "../domain/verify/fingerprint.ts";
import { AppError } from "../domain/errors.ts";
import { canonicalPath, isInsideRoot } from "../infra/paths.ts";
import { writeInsideRoot } from "../infra/safe-read.ts";
import { runFixLoop } from "./fix-loop.ts";
import type { FixLoopResult } from "./fix-loop.ts";

export const PROMPT_VERSION = "v1";

export type RunAuditDeps = {
  runner: AuditRunner;
  llm: LlmStrategyRunner | null;
  servers: StaticServerFactory;
  clock: Clock;
  logger: Logger;
  scratch: ScratchFactory;
  /** Reads a page file of the source root as text (readInsideRoot in production). */
  readPage: (root: string, rel: string) => string;
  /** True for an existing regular file inside the root (existsInsideRoot in production). */
  exists: (root: string, rel: string) => boolean;
  catalog?: Record<string, Strategy[]>;
  profile?: AuditProfile;
};

/**
 * The serializable AuditResult plus what the patch and --write steps need (source-root-relative names, none
 * of it part of audit.json): the combined diff and content of every touched file, the page files as the
 * baseline audit read them, and the content --write put on disk (empty without a write).
 * writeSubsetAudited is true when --write needed its own audit of the verified subset.
 */
export type AuditRun = AuditResult & {
  diffs: Record<string, string>;
  combinedFiles: Record<string, string>;
  baselineFiles: Record<string, string>;
  writtenFiles: Record<string, string>;
  writeSubsetAudited: boolean;
  /** The kind of the provider failure behind the llm-unavailable warning (spec 5.10), or null. */
  llmUnavailableKind: string | null;
};

/** The --out directory, when it lies inside the source root (P-10): it is left out of every scratch copy. */
export function excludedOutDirs(config: Pick<AuditConfig, "sourceRoot" | "out">): string[] {
  const out = canonicalPath(resolve(config.out));
  const root = canonicalPath(resolve(config.sourceRoot));
  return out !== root && isInsideRoot(root, out) ? [out] : [];
}

const findingIdOf = (o: FixOutcome): string => ("candidate" in o ? o.candidate.findingId : o.findingId);

function summaryOf(findings: Finding[], outcomes: FixOutcome[], fixableByPatch: number): Summary {
  const count = (status: FixOutcome["status"]) => outcomes.filter((o) => o.status === status).length;
  const accepted = outcomes.filter((o) => o.status === "accepted");
  return {
    violations: findings.filter((f) => f.source === "axe" && f.status === "violation").length,
    incomplete: findings.filter((f) => f.source === "axe" && f.status === "incomplete").length,
    keyboard: findings.filter((f) => f.source === "keyboard").length,
    accepted: accepted.length,
    verified: accepted.filter((o) => o.verified === "verified").length,
    verifiedNeedsReview: accepted.filter((o) => o.verified === "verified-present-needs-review").length,
    rejected: count("rejected"),
    gateRejected: count("gate-rejected"),
    suggestOnly: count("suggest-only"),
    unmapped: count("unmapped"),
    conflicts: count("conflict"),
    skipped: count("skipped"),
    remainingInSource: findings.length,
    fixableByPatch,
  };
}

/** Serves a scratch copy of the source (with files written over it) and audits it. Returns the snapshot and the copy's page files. */
async function auditScratchCopy(
  config: AuditConfig,
  deps: RunAuditDeps,
  profile: AuditProfile,
  files: Record<string, string>,
  watch: string[],
  opts: AuditOptions,
): Promise<{ snapshot: AuditSnapshot; pageFiles: Record<string, string> }> {
  const copy = await deps.scratch.create(config.sourceRoot, { excludeAbs: excludedOutDirs(config) });
  try {
    copy.write(files);
    const server = await deps.servers.start(copy.root);
    try {
      const target: AuditTarget = { url: server.url + config.pagePath, servedRoot: copy.root, pagePath: config.pagePath, watch: [...watch].sort() };
      return { snapshot: await deps.runner.audit(target, profile, opts), pageFiles: copy.files() };
    } finally {
      await server.close();
    }
  } finally {
    copy.dispose();
  }
}

/** The page file of the configured page path, or null when it has no file. */
function pageFileOf(config: AuditConfig, deps: RunAuditDeps): string | null {
  const page = pageFileFor(config.pagePath, (rel) => deps.exists(config.sourceRoot, rel));
  return typeof page === "string" ? page : null;
}

/** Fingerprints that make an audit disagree with the verdicts: a target still present, or any new finding (spec 5.6 step 5). */
function mismatchesOf(targets: Finding[], baselineFindings: Finding[], after: Finding[]): string[] {
  const before = findingSetOf(baselineFindings);
  const now = findingSetOf(after);
  const out = new Set<string>();
  for (const t of targets) if (now.violations.has(t.fingerprint) || now.incomplete.has(t.fingerprint)) out.add(t.fingerprint);
  for (const fp of now.violations) if (!before.violations.has(fp)) out.add(fp);
  for (const fp of now.incomplete) if (!before.incomplete.has(fp)) out.add(fp);
  for (const fp of now.keyboard) if (!before.keyboard.has(fp)) out.add(fp);
  return [...out];
}

/** The write step refused: nothing was written. The run carries the warnings so the CLI can still write the outputs. */
export class CombinedMismatchError extends AppError {
  run: AuditRun;
  constructor(run: AuditRun, details?: unknown) {
    super("COMBINED_MISMATCH", "Combined audit disagrees with per-fix verification; nothing written. See warnings in audit.json", details);
    this.name = "CombinedMismatchError";
    this.run = run;
  }
}

/**
 * --write (spec 5.8 row --write; OUT-05, VER-05, CLI-02): writes only the accepted, included fixes with status
 * verified. When that subset is the combined set, the audited combined tree is written as is. Otherwise a pure
 * combine of the subset goes to a scratch copy that is audited once; a written target still present, or a new
 * finding, refuses the write. Every target is checked (no symlink, inside the root, unchanged since the audit)
 * before the first byte is written. remainingInSource becomes the audit of the written tree.
 */
export async function writeVerifiedFixes(run: AuditRun, config: AuditConfig, deps: RunAuditDeps): Promise<AuditRun> {
  const log = deps.logger.child({ component: "output" });
  const profile = deps.profile ?? DEFAULT_PROFILE;
  const refuse = (extra: string[], details: unknown): never => {
    throw new CombinedMismatchError({ ...run, warnings: [...run.warnings, ...extra] }, details);
  };
  const open = run.warnings.filter((w) => w.startsWith("combined-audit-mismatch:"));
  if (open.length > 0) refuse([], { reason: "combined-audit-mismatch", warnings: open });

  const includedIds = new Set(run.combined?.included ?? []);
  const accepted = run.outcomes.filter((o): o is Extract<FixOutcome, { status: "accepted" }> => o.status === "accepted" && includedIds.has(o.candidate.findingId));
  const subset = accepted.filter((o) => o.verified === "verified");
  const left = accepted.filter((o) => o.verified !== "verified");
  const leftWarning = left.length > 0 ? [`left-in-patch:${left.map((o) => o.candidate.findingId).join(",")}`] : [];

  if (subset.length === 0) {
    log.info("write_done", { files: 0, fixes: 0, left: left.length });
    return { ...run, written: { files: [], fixes: [], remaining: run.findings }, warnings: [...run.warnings, ...leftWarning] };
  }

  /** Every target must be a regular file inside the root, not a symlink, and unchanged since the audit. Nothing is written before all pass. */
  const preflight = (names: string[]): void => {
    for (const rel of names) {
      const current = deps.readPage(config.sourceRoot, rel); // throws UNSAFE_PATH for a symlink or a path outside the root
      if (current !== run.baselineFiles[rel]) refuse([], { reason: "source-changed", file: rel });
    }
  };

  let files: Record<string, string>;
  let remaining: Finding[];
  let audited = false;
  if (subset.length === accepted.length && run.combined) {
    files = run.combinedFiles;
    remaining = run.combined.remaining;
    preflight(Object.keys(files).sort());
  } else {
    const sub = combineEdits(run.baselineFiles, subset.map((o) => o.candidate), run.baseline.domIds);
    if (sub.conflicts.length > 0 || sub.included.length !== subset.length) refuse([], { reason: "subset-conflict", conflicts: sub.conflicts });
    preflight(Object.keys(sub.files).sort());
    const targets = subset.map((o) => run.findings.find((f) => f.id === o.candidate.findingId)!);
    const watch = [...new Set(targets.map((f) => domKey(f.node)))];
    const after = await auditScratchCopy(config, deps, profile, sub.files, watch, {});
    audited = true;
    remaining = analyzeSnapshot(after.snapshot, buildHtmlIndex(after.pageFiles), pageFileOf(config, deps), profile);
    const mismatches = mismatchesOf(targets, run.findings, remaining);
    if (mismatches.length > 0) {
      for (const fp of mismatches) log.warn("combined_audit_mismatch", { fingerprint: fp, audit: "write-subset" });
      refuse(mismatches.map((fp) => `combined-audit-mismatch:${fp}`), { reason: "write-subset-mismatch" });
    }
    files = sub.files;
  }

  const names = Object.keys(files).sort();
  // writeInsideRoot checks each path again (lstat per segment), so a link created after the preflight is refused too.
  for (const rel of names) writeInsideRoot(config.sourceRoot, rel, files[rel]!);
  log.info("write_done", { files: names.length, fixes: subset.length, left: left.length, subsetAudited: audited });

  return {
    ...run,
    summary: { ...run.summary, remainingInSource: remaining.length, fixableByPatch: accepted.length - subset.length },
    warnings: [...run.warnings, ...leftWarning],
    written: { files: names, fixes: subset.map((o) => o.candidate.findingId), remaining },
    writtenFiles: { ...files },
    writeSubsetAudited: audited,
  };
}

export async function runAudit(config: AuditConfig, deps: RunAuditDeps): Promise<AuditRun> {
  const { runner, servers, clock, scratch } = deps;
  const logger = deps.logger.child({ component: "loop" });
  const profile = deps.profile ?? DEFAULT_PROFILE;
  const started = clock.now().getTime();
  const deadlineAt = started + config.deadlineMs;
  const excludeAbs = excludedOutDirs(config);

  const auditCopy = (files: Record<string, string>, watch: string[], opts: AuditOptions) => auditScratchCopy(config, deps, profile, files, watch, opts);

  // Baseline: a scratch copy, never the source root itself. The copy lists the page files; their text is read from the source root.
  const base = await auditCopy({}, [], { screenshot: "page.png" });
  const baseline = base.snapshot;
  const baselineFiles: Record<string, string> = {};
  for (const rel of Object.keys(base.pageFiles).sort()) baselineFiles[rel] = deps.readPage(config.sourceRoot, rel);
  const index = buildHtmlIndex(baselineFiles);
  const pageFile = pageFileOf(config, deps);
  const findings = analyzeSnapshot(baseline, index, pageFile, profile);
  const baselineDone = clock.now().getTime();

  let loop: FixLoopResult = { outcomes: [], accepted: [], limits: { candidatesUsed: 0, llmCallsUsed: 0, deadlineHit: false }, llmCalls: 0, llmUnavailable: false, llmUnavailableKind: null };
  if (config.fix) {
    loop = await runFixLoop(
      { config, baseline, findings, baselineFiles, index, pageFile, profile, deadlineAt, excludeAbs },
      { runner, servers, scratch, clock, logger, llm: deps.llm, ...(deps.catalog ? { catalog: deps.catalog } : {}) },
    );
  }
  const loopDone = clock.now().getTime();

  // Edit-level combine of the accepted candidates, in finding order.
  const combine = combineEdits(baselineFiles, loop.accepted, baseline.domIds);
  const outcomes: FixOutcome[] = [...loop.outcomes];
  for (const c of combine.conflicts) outcomes.push({ status: "conflict", findingId: c.findingId, with: c.with, reason: c.reason });
  // Keep each conflict next to its finding's other outcomes.
  const order = new Map(findings.map((f, i) => [f.id, i]));
  outcomes.sort((x, y) => (order.get(findingIdOf(x)) ?? 0) - (order.get(findingIdOf(y)) ?? 0));

  const warnings: string[] = [];
  let combined: AuditResult["combined"] = null;
  if (combine.included.length > 0) {
    // The combined audit runs even after the deadline (spec 5.6 "Run limits").
    const targets = combine.included.map((id) => findings.find((f) => f.id === id)!);
    const watch = [...new Set(targets.map((f) => domKey(f.node)))];
    const after = await auditCopy(combine.files, watch, { screenshot: "page.after.png" });
    const remaining = analyzeSnapshot(after.snapshot, buildHtmlIndex(after.pageFiles), pageFile, profile);
    const mismatches = mismatchesOf(targets, findings, remaining);
    for (const fp of mismatches) {
      warnings.push(`combined-audit-mismatch:${fp}`);
      logger.warn("combined_audit_mismatch", { fingerprint: fp });
    }
    combined = { snapshot: after.snapshot, remaining, included: combine.included };
  }
  if (loop.llmUnavailable) warnings.push("llm-unavailable");
  const done = clock.now().getTime();

  const result: AuditRun = {
    config,
    baseline,
    findings,
    outcomes,
    combined,
    summary: summaryOf(findings, outcomes, combine.included.length),
    timings: { baselineMs: baselineDone - started, loopMs: loopDone - baselineDone, combinedMs: done - loopDone, totalMs: done - started },
    limits: loop.limits,
    llm: { provider: config.llm.provider, calls: loop.llmCalls, promptVersion: PROMPT_VERSION },
    warnings,
    written: null,
    diffs: combine.diffs,
    combinedFiles: combine.files,
    baselineFiles,
    writtenFiles: {},
    writeSubsetAudited: false,
    llmUnavailableKind: loop.llmUnavailableKind,
  };
  logger.info("run_done", { findings: findings.length, mapped: findings.filter((f) => !isUnmapped(f.location)).length, ...result.summary, warnings: warnings.length, ms: result.timings.totalMs });
  return config.write ? writeVerifiedFixes(result, config, deps) : result;
}
