// The fix catalog contract (spec 5.5, 5.6): what a strategy receives and what it may return. Pure.
import type { AuditConfig } from "../../contracts/config.ts";
import type { Finding, SourceLocation } from "../../contracts/finding.ts";
import type { FixOutcome, FixPlan, GateRejectReason } from "../../contracts/fix.ts";
import type { LlmTaskName } from "../../contracts/llm.ts";
import type { AuditSnapshot } from "../../contracts/snapshot.ts";
import type { HtmlIndex } from "../map/html-index.ts";
import type { IdAllocator } from "./id-allocator.ts";

/** Everything a strategy may read. Offsets in location refer to source, the baseline text of location.file. */
export type FixContext = {
  finding: Finding;
  location: SourceLocation;
  /** The baseline text of location.file. */
  source: string;
  index: HtmlIndex;
  /** The baseline snapshot (domIds for DOM-aware strategies). */
  snapshot: AuditSnapshot;
  config: Pick<AuditConfig, "lang" | "allowNewIncomplete">;
  /** The run-level allocator (P-14): has() is "reserved in this run", allocate() checks the file, the DOM and the reservations. */
  ids: IdAllocator;
};

export type SuggestReason = Extract<FixOutcome, { status: "suggest-only" }>["reason"];

/** skip: the strategy's precondition is absent, so the loop moves on to the next strategy. */
export type StrategyResult = { type: "plan"; plan: FixPlan } | { type: "suggest"; reason: SuggestReason; plan: FixPlan } | { type: "skip" };

export type DeterministicStrategy = { name: string; kind: "deterministic"; run(ctx: FixContext): StrategyResult };
export type SuggestStrategy = { name: string; kind: "suggest-only"; suggest(ctx: FixContext): string };
export type LlmStrategy = {
  name: "alt-text-llm" | "aria-label-llm";
  kind: "llm";
  task: LlmTaskName;
  role?: "button" | "link" | "textbox";
  /** Turns a gated provider output into a plan (or a suggestion, for a decorative image). */
  toResult(ctx: FixContext, output: unknown): StrategyResult;
};
export type Strategy = DeterministicStrategy | SuggestStrategy | LlmStrategy;

/**
 * Runs one LLM strategy attempt (src/app/llm-strategies.ts). result: a gated value turned into a
 * StrategyResult; gate-rejected: a value gate refused the proposal (attempt 2 gets the reason as feedback);
 * no-proposal: the provider has nothing to offer; unavailable: the provider failed after its retries.
 */
export type LlmProposal =
  | { type: "result"; result: StrategyResult; proposal: unknown; requestId: string }
  | { type: "gate-rejected"; reason: GateRejectReason; proposal: unknown }
  | { type: "no-proposal"; reason: "llm-disabled" | "no-scripted-answer" }
  | { type: "unavailable"; kind: string };

export type LlmStrategyRunner = {
  propose(args: { strategy: LlmStrategy; ctx: FixContext; attempt: 1 | 2; feedback: string | null }): Promise<LlmProposal>;
};
