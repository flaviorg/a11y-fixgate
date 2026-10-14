// LLM strategy descriptors (spec 5.5; FIX-05, FIX-06). The provider call and the value gates live in the
// LlmStrategyRunner (src/app/llm-strategies.ts); toResult only turns an already gated output into a plan. Pure.
import { altTextOutput, controlNameOutput } from "../../../contracts/llm.ts";
import { basePlan } from "../plan.ts";
import type { LlmStrategy, StrategyResult } from "../types.ts";
import { attributeEdit } from "./set-attribute.ts";

const SKIP: StrategyResult = { type: "skip" };

/** aria-label from a control-name proposal; flagged llm-text (the browser verifies presence, not meaning). */
export function ariaLabelLlm(role: "button" | "link" | "textbox"): LlmStrategy {
  return {
    name: "aria-label-llm",
    kind: "llm",
    task: "control-name",
    role,
    toResult(ctx, output) {
      const parsed = controlNameOutput.safeParse(output);
      if (!parsed.success) return SKIP;
      const plan = basePlan("aria-label-llm", "llm", `aria-label="${parsed.data.name}"`);
      plan.edits = [attributeEdit(ctx.location, "aria-label", parsed.data.name, ctx.source)];
      plan.needsHumanReview = true;
      plan.reviewReason = "llm-text";
      return { type: "plan", plan };
    },
  };
}

/** alt from an alt-text proposal: informative adds alt; decorative is only a suggestion (never alt="" in v1). */
export const altTextLlm: LlmStrategy = {
  name: "alt-text-llm",
  kind: "llm",
  task: "alt-text",
  toResult(ctx, output) {
    const parsed = altTextOutput.safeParse(output);
    if (!parsed.success) return SKIP;
    if (parsed.data.kind === "decorative") {
      return { type: "suggest", reason: "decorative-needs-decision", plan: basePlan("alt-text-llm", "llm", `decorative proposed (alt=""): ${parsed.data.reason}`) };
    }
    const plan = basePlan("alt-text-llm", "llm", `alt="${parsed.data.alt}"`);
    plan.edits = [attributeEdit(ctx.location, "alt", parsed.data.alt, ctx.source)];
    plan.needsHumanReview = true;
    plan.reviewReason = "llm-text";
    return { type: "plan", plan };
  },
};
