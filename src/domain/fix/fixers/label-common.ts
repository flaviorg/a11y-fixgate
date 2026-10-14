// Shared precondition of the label strategies (spec 5.5 label, FIX-04). Pure.
import type { IndexedElement, IndexedFile } from "../../map/html-index.ts";
import { targetOf } from "../plan.ts";
import type { FixContext } from "../types.ts";

export type LabelPair = { file: IndexedFile; label: IndexedElement; input: IndexedElement };

/** A <label> that is the input's previous element sibling, else its parent; with or without a for attribute. */
export function adjacentLabel(ctx: FixContext): LabelPair | null {
  const target = targetOf(ctx);
  if (!target) return null;
  const { file, el: input, at } = target;
  let previous: IndexedElement | null = null;
  for (let i = at - 1; i >= 0; i--) {
    const e = file.elements[i]!;
    if (e.parent === input.parent) {
      previous = e;
      break;
    }
  }
  if (previous && previous.tag === "label") return { file, label: previous, input };
  const parent = input.parent === null ? null : file.elements[input.parent]!;
  return parent && parent.tag === "label" ? { file, label: parent, input } : null;
}

/** The plan-level precondition: an adjacent label without a for attribute. */
export function labelFor(ctx: FixContext): LabelPair | null {
  const pair = adjacentLabel(ctx);
  return pair && !Object.hasOwn(pair.label.attrs, "for") ? pair : null;
}

/** A name turned into an id base: trimmed, whitespace runs to "-"; "" when nothing is left. */
export function idBase(name: string | undefined): string {
  return (name ?? "").trim().replace(/\s+/g, "-");
}

export function idSummary(id: string, withInputId: boolean): string {
  return withInputId ? `id="${id}" / for="${id}"` : `for="${id}"`;
}
