// label-associate (spec 5.5 label strategy 1, FIX-04, P-14; ADR 0006): source-only. It reasons over the page
// file like a static fixer would and never consults snapshot.domIds; the browser re-audit catches a collision
// with a script-injected id. Pure.
import { basePlan } from "../plan.ts";
import type { DeterministicStrategy } from "../types.ts";
import { idBase, idSummary, labelFor } from "./label-common.ts";
import { attributeEdit } from "./set-attribute.ts";

export const labelAssociate: DeterministicStrategy = {
  name: "label-associate",
  kind: "deterministic",
  run(ctx) {
    const pair = labelFor(ctx);
    if (!pair) return { type: "skip" };
    const { file, label, input } = pair;
    const existing = (input.attrs["id"] ?? "").trim();
    let id = existing;
    if (id === "") {
      // P-14: the first value absent from the file's ids and not reserved in this run.
      const fileIds = new Set(file.ids);
      const free = (c: string) => c !== "" && !fileIds.has(c) && !ctx.ids.has(c);
      const name = idBase(input.attrs["name"]);
      if (free(name)) id = name;
      else {
        let n = 1;
        while (!free(`field-${n}`)) n++;
        id = `field-${n}`;
      }
    }
    const plan = basePlan("label-associate", "deterministic", idSummary(id, existing === ""));
    const forEdit = attributeEdit(label.location, "for", id, ctx.source);
    plan.edits = existing === "" ? [forEdit, attributeEdit(input.location, "id", id, ctx.source)] : [forEdit];
    plan.generatedIds = existing === "" ? [id] : [];
    return { type: "plan", plan };
  },
};
