// contrast-inline (spec 5.5 color-contrast, FIX-07): when the inline style declares the foreground color axe
// reported, replace only that declaration's value with the nearest compliant color of the same hue and
// saturation. Always flagged design-review: the browser proves the ratio, not the taste. Pure.
import { contrastRatio, nearestCompliant, parseColor } from "../../color/contrast.ts";
import { basePlan } from "../plan.ts";
import type { DeterministicStrategy, FixContext, StrategyResult } from "../types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;
const sameColor = (a: string, b: string) => {
  const [x, y] = [parseColor(a), parseColor(b)];
  return x !== null && y !== null && x.r === y.r && x.g === y.g && x.b === y.b;
};

/** Offsets (in the source) of the value of the inline `color` declaration equal to fg, or null. */
function inlineColorValue(ctx: FixContext, fg: string): { startOffset: number; endOffset: number } | null {
  const range = Object.hasOwn(ctx.location.attrs, "style") ? ctx.location.attrs["style"]! : null;
  if (!range) return null;
  const raw = ctx.source.slice(range.startOffset, range.endOffset);
  const head = /^style\s*=\s*(["']?)/i.exec(raw);
  if (!head) return null;
  const quote = head[1]!;
  const valueStart = head[0].length;
  const valueEnd = quote && raw.endsWith(quote) ? raw.length - 1 : raw.length;
  const value = raw.slice(valueStart, valueEnd);
  if (value.includes("&")) return null; // character references: offsets of the decoded text would not match the source
  const decl = /(^|;)(\s*color\s*:\s*)([^;]*)/gi;
  for (const m of value.matchAll(decl)) {
    const text = m[3]!.replace(/\s*!important\s*$/i, "").trimEnd();
    if (!sameColor(text, fg)) continue;
    const at = range.startOffset + valueStart + m.index + m[1]!.length + m[2]!.length;
    return { startOffset: at, endOffset: at + text.length };
  }
  return null;
}

export const contrastInline: DeterministicStrategy = {
  name: "contrast-inline",
  kind: "deterministic",
  run(ctx): StrategyResult {
    const { fgColor, bgColor, expectedContrastRatio } = ctx.finding.data as { fgColor?: unknown; bgColor?: unknown; expectedContrastRatio?: unknown };
    const target = Number.parseFloat(String(expectedContrastRatio ?? ""));
    if (typeof fgColor !== "string" || typeof bgColor !== "string" || !Number.isFinite(target)) return { type: "skip" };
    const nearest = nearestCompliant(fgColor, bgColor, target);
    const before = round2(contrastRatio(fgColor, bgColor));
    const value = nearest ? inlineColorValue(ctx, fgColor) : null;
    if (!nearest || !value) {
      const summary = nearest
        ? `Change the text color ${fgColor} to ${nearest.hex} (${before}:1 -> ${nearest.ratio}:1 on ${bgColor}); the color is not declared in the element's inline style`
        : `No color of the same hue and saturation reaches ${target}:1 on ${bgColor}; change the background or the hue`;
      return { type: "suggest", reason: "catalog", plan: basePlan("contrast-inline", "suggest-only", summary) };
    }
    const plan = basePlan("contrast-inline", "deterministic", `color:${fgColor} -> ${nearest.hex} (${before}:1 -> ${nearest.ratio}:1 on ${bgColor})`);
    plan.edits = [{ range: { file: ctx.location.file, ...value }, replacement: nearest.hex, kind: "attribute", startTag: { file: ctx.location.file, ...ctx.location.startTag } }];
    plan.needsHumanReview = true;
    plan.reviewReason = "design-review";
    return { type: "plan", plan };
  },
};
