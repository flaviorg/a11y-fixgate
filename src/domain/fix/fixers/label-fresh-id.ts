// label-fresh-id (spec 5.5 label strategy 2, FIX-04, FIX-10): DOM-aware. Same adjacency precondition, or an
// adjacent <label for="X"> whose X is dangling or duplicated in snapshot.domIds. The id comes from the run's
// allocator, which checks the file, the DOM and the ids reserved by accepted candidates. Pure.
import { basePlan } from "../plan.ts";
import type { DeterministicStrategy } from "../types.ts";
import { adjacentLabel, idBase, idSummary } from "./label-common.ts";
import { attributeEdit } from "./set-attribute.ts";

export const labelFreshId: DeterministicStrategy = {
  name: "label-fresh-id",
  kind: "deterministic",
  run(ctx) {
    const pair = adjacentLabel(ctx);
    if (!pair) return { type: "skip" };
    const { label, input } = pair;
    if (Object.hasOwn(label.attrs, "for")) {
      const target = label.attrs["for"]!;
      const count = ctx.snapshot.domIds.filter((x) => x === target).length;
      if (count === 1) return { type: "skip" }; // the label already names exactly one other element
    }
    const id = ctx.ids.allocate(idBase(input.attrs["name"]) || "field");
    const plan = basePlan("label-fresh-id", "deterministic", idSummary(id, true));
    plan.edits = [
      attributeEdit(label.location, "for", id, ctx.source),
      attributeEdit(input.location, "id", id, ctx.source),
    ];
    plan.generatedIds = [id];
    return { type: "plan", plan };
  },
};
