// title-from-h1 (spec 5.5 document-title, FIX-03): <title> with the collapsed text of the first <h1>, inserted
// right after the <head> start tag, or filling an empty <title>. Pure.
import type { Edit } from "../../../contracts/fix.ts";
import { basePlan, elementsByTag, escapeText, fileOf } from "../plan.ts";
import type { DeterministicStrategy } from "../types.ts";

const MAX_TITLE = 120;

/** The h1 text cut so that its escaped form fits the bounds gate's 120 characters. */
function titleText(text: string): string {
  let raw = text.slice(0, MAX_TITLE).trim();
  while (escapeText(raw).length > MAX_TITLE) raw = raw.slice(0, -1).trimEnd();
  return escapeText(raw);
}

export const titleFromH1: DeterministicStrategy = {
  name: "title-from-h1",
  kind: "deterministic",
  run(ctx) {
    const file = fileOf(ctx);
    const head = file ? elementsByTag(file, "head")[0] : undefined;
    const h1 = file ? elementsByTag(file, "h1").find((e) => e.text !== "") : undefined;
    if (!file || !head || !h1) {
      const why = !head ? "the page has no explicit <head>" : "the page has no <h1> with text";
      return { type: "suggest", reason: "catalog", plan: basePlan("title-from-h1", "suggest-only", `Add a <title> that names the page (${why})`) };
    }
    const element = `<title>${titleText(h1.text)}</title>`;
    const plan = basePlan("title-from-h1", "deterministic", element);
    const file0 = ctx.location.file;
    const empty = elementsByTag(file, "title").find((t) => t.text === "");
    const edit: Edit = empty
      ? { range: { file: file0, startOffset: empty.location.startOffset, endOffset: empty.location.endOffset }, replacement: element, kind: "element-insert", startTag: { file: file0, ...empty.location.startTag } }
      : { range: { file: file0, startOffset: head.location.startTag.endOffset, endOffset: head.location.startTag.endOffset }, replacement: element, kind: "element-insert", startTag: { file: file0, ...head.location.startTag } };
    plan.edits = [edit];
    return { type: "plan", plan };
  },
};
