// The LLM strategy runner (spec 5.5, 5.6 "Outer loop", 6.2 items 5 and 6; LLM-02, FIX-05, FIX-06): builds the
// task input from the source, calls the provider, runs the value gates and turns a gated value into a plan.
// The model returns a value only; every edit, gate and decision is deterministic code.
import type { AltTextInput, ControlNameInput } from "../contracts/llm.ts";
import { LlmUnavailableError } from "../domain/errors.ts";
import { altGate, nameGate } from "../domain/fix/gates.ts";
import type { LlmProposal, LlmStrategyRunner, StrategyResult } from "../domain/fix/types.ts";
import type { LlmProvider, Logger } from "../domain/ports.ts";
import { readInsideRoot } from "../infra/safe-read.ts";
import { llmKey } from "../llm/fixture-format.ts";
import { altTextInputFor, controlNameInputFor } from "./page-context.ts";

export type LlmStrategyRunnerDeps = {
  provider: LlmProvider;
  sourceRoot: string;
  pagePath: string;
  logger: Logger;
  /** Reads project files (images); readInsideRoot by default. */
  read?: typeof readInsideRoot;
  /** Aborts in-flight provider calls (for example on SIGINT). */
  signal?: AbortSignal;
};

/** Attaches the provenance of an LLM value to the plan of a result (spec 5.1 FixPlan.llm). */
function withLlm(result: StrategyResult, llm: NonNullable<Extract<StrategyResult, { type: "plan" }>["plan"]["llm"]>): StrategyResult {
  if (result.type === "skip") return result;
  return { ...result, plan: { ...result.plan, llm } };
}

export function createLlmStrategyRunner(deps: LlmStrategyRunnerDeps): LlmStrategyRunner {
  const { provider, sourceRoot, pagePath } = deps;
  const log = deps.logger.child({ component: "llm" });
  const read = deps.read ?? readInsideRoot;
  const signal = deps.signal ?? new AbortController().signal;

  return {
    async propose({ strategy, ctx, attempt, feedback }): Promise<LlmProposal> {
      const task = strategy.task;
      const input: AltTextInput | ControlNameInput =
        task === "alt-text" ? altTextInputFor(ctx, { sourceRoot, pagePath, read, logger: log }) : controlNameInputFor(ctx, strategy.role ?? "button");
      const requestId = `${ctx.finding.id}/${strategy.name}/a${attempt}`;
      const key = llmKey(task, input);
      const base = { requestId, findingId: ctx.finding.id, task, provider: provider.name, attempt, key };

      let res;
      try {
        res = task === "alt-text" ? await provider.complete("alt-text", input as AltTextInput, { requestId, signal, attempt, feedback }) : await provider.complete("control-name", input as ControlNameInput, { requestId, signal, attempt, feedback });
      } catch (error) {
        if (error instanceof LlmUnavailableError) {
          log.warn("call", { ...base, gate: "unavailable", reason: error.kind });
          return { type: "unavailable", kind: error.kind };
        }
        throw error;
      }
      if (res.kind === "no-proposal") {
        log.info("call", { ...base, gate: "no-proposal", reason: res.reason });
        return { type: "no-proposal", reason: res.reason };
      }

      const gated = task === "alt-text" ? altGate(res.output, input as AltTextInput, (input as AltTextInput).surroundingText) : nameGate(res.output, input as ControlNameInput);
      if (!gated.ok) {
        log.info("call", { ...base, gate: "rejected", reason: gated.reason });
        return { type: "gate-rejected", reason: gated.reason, proposal: res.output };
      }
      log.info("call", { ...base, gate: "passed" });
      const result = withLlm(strategy.toResult(ctx, gated.output), { task, requestId, attempt, proposal: res.output, gate: "passed" });
      return { type: "result", result, proposal: res.output, requestId };
    },
  };
}

/** The strategy runner for a provider; the none provider needs none (LLM strategies become suggest-only: llm-disabled without a call). */
export function strategyRunnerFor(provider: LlmProvider, deps: Omit<LlmStrategyRunnerDeps, "provider">): LlmStrategyRunner | null {
  return provider.name === "none" ? null : createLlmStrategyRunner({ provider, ...deps });
}
