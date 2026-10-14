// html-lang (spec 5.5 html-has-lang, FIX-02): lang on the <html> start tag from --lang, else from a page
// signal (content-language, then og:locale), which is flagged inferred-lang. Pure.
import { basePlan, elementsByTag, fileOf } from "../plan.ts";
import type { DeterministicStrategy, FixContext } from "../types.ts";
import { attributeEdit } from "./set-attribute.ts";

const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A signal value as a language tag: first entry of a list, "_" to "-", primary subtag lower-cased; null when invalid. */
function normalizeTag(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const first = raw.split(",")[0]!.trim().replaceAll("_", "-");
  const [primary = "", ...rest] = first.split("-");
  const tag = [primary.toLowerCase(), ...rest].join("-");
  return LANG_TAG.test(tag) ? tag : null;
}

/** content-language first, then og:locale; the first valid value wins. */
function pageSignal(ctx: FixContext): string | null {
  const file = fileOf(ctx);
  if (!file) return null;
  const metas = elementsByTag(file, "meta");
  const httpEquiv = metas.find((m) => m.attrs["http-equiv"]?.trim().toLowerCase() === "content-language");
  const og = metas.find((m) => m.attrs["property"]?.trim().toLowerCase() === "og:locale");
  return normalizeTag(httpEquiv?.attrs["content"]) ?? normalizeTag(og?.attrs["content"]);
}

export const htmlLang: DeterministicStrategy = {
  name: "html-lang",
  kind: "deterministic",
  run(ctx) {
    if (ctx.finding.node.tag !== "html") return { type: "skip" };
    const inferred = ctx.config.lang === null ? pageSignal(ctx) : null;
    const lang = ctx.config.lang ?? inferred;
    if (lang === null) {
      return { type: "suggest", reason: "lang-unknown", plan: basePlan("html-lang", "suggest-only", 'Set the page language with --lang (for example --lang en); no content-language or og:locale signal found') };
    }
    const plan = basePlan("html-lang", "deterministic", `lang="${lang}"`);
    plan.edits = [attributeEdit(ctx.location, "lang", lang, ctx.source)];
    if (inferred !== null) {
      plan.needsHumanReview = true;
      plan.reviewReason = "inferred-lang";
    }
    return { type: "plan", plan };
  },
};
