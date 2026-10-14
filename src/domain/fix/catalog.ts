// The fix catalog (spec 5.5, FIX-01): strategies per rule in a fixed order, deterministic before LLM, at most
// 3 per rule. Suggest-only entries carry the spec 5.5 message templates. Pure.
import { contrastInline } from "./fixers/contrast-inline.ts";
import { titleFromH1 } from "./fixers/document-title.ts";
import { htmlLang } from "./fixers/html-lang.ts";
import { labelAssociate } from "./fixers/label-associate.ts";
import { labelFreshId } from "./fixers/label-fresh-id.ts";
import { altTextLlm, ariaLabelLlm } from "./fixers/llm-descriptors.ts";
import type { FixContext, Strategy, SuggestStrategy } from "./types.ts";

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
/** The node's selector for a message: an axe target (a JSON array of strings) is shown as plain text. */
function selectorOf(ctx: FixContext): string {
  const raw = ctx.finding.node.selector;
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((p) => typeof p === "string") ? parsed.join(" ") : raw;
  } catch {
    return raw;
  }
}

export const targetSizeAdvice: SuggestStrategy = {
  name: "target-size-advice",
  kind: "suggest-only",
  suggest(ctx) {
    const d = ctx.finding.data;
    const min = num(d["minSize"], 24);
    return `Target ${selectorOf(ctx)} is ${num(d["width"], 0)} by ${num(d["height"], 0)} px; the minimum is ${min} by ${min} px. Give it min-width: ${min}px; min-height: ${min}px (or padding), or keep ${min} px of space around it`;
  },
};

export const keyboardTrapAdvice: SuggestStrategy = {
  name: "keyboard-trap-advice",
  kind: "suggest-only",
  suggest: (ctx) => `Focus stayed on ${selectorOf(ctx)} for ${num(ctx.finding.data["repeats"], 3)} Tabs; keydown handlers that cancel Tab must let it through or provide an exit (Esc)`,
};

export const unreachableControlAdvice: SuggestStrategy = {
  name: "unreachable-control-advice",
  kind: "suggest-only",
  suggest(ctx) {
    const tag = ctx.finding.node.tag;
    const reason = str(ctx.finding.data["reason"], "onclick");
    if (reason === "role-link") return `Use <a href> instead of <${tag} role="link">; or add tabindex="0" and a keydown handler for Enter`;
    const what = reason === "role-button" ? `<${tag} role="button">` : `<${tag} onclick>`;
    return `Use <button> instead of ${what}; or add tabindex="0", role="button" and a keydown handler for Enter and Space`;
  },
};

export const focusObscuredAdvice: SuggestStrategy = {
  name: "focus-obscured-advice",
  kind: "suggest-only",
  suggest(ctx) {
    const points = num(ctx.finding.data["coveredPoints"], 0);
    const extent = points >= 5 ? "fully (5 of 5 points)" : `partly (${points} of 5)`;
    return `Focused ${selectorOf(ctx)} is ${extent} covered by ${str(ctx.finding.data["coveredBy"], "another element")}; add scroll-margin-top or make the header non-overlapping`;
  },
};

export const CATALOG: Record<string, Strategy[]> = {
  "html-has-lang": [htmlLang],
  "document-title": [titleFromH1],
  label: [labelAssociate, labelFreshId, ariaLabelLlm("textbox")],
  "button-name": [ariaLabelLlm("button")],
  "link-name": [ariaLabelLlm("link")],
  "image-alt": [altTextLlm],
  "color-contrast": [contrastInline],
  "target-size": [targetSizeAdvice],
  "keyboard-trap": [keyboardTrapAdvice],
  "unreachable-control": [unreachableControlAdvice],
  "focus-obscured": [focusObscuredAdvice],
};

/** The strategies of a rule in catalog order; an unknown rule has none. */
export function strategiesFor(ruleId: string, catalog: Record<string, Strategy[]> = CATALOG): Strategy[] {
  return Object.hasOwn(catalog, ruleId) ? [...catalog[ruleId]!] : [];
}
