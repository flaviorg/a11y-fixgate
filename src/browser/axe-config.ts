// axe configuration (spec 5.3, AUD-01, AUD-02). The only module that imports axe-core at run time.
import axe from "axe-core";
import { AXE_TAGS } from "../contracts/snapshot.ts";

export { AXE_TAGS };

export type AxeRunOptions = {
  runOnly: { type: "tag"; values: string[] };
  resultTypes: Array<"violations" | "incomplete">;
};

/** The options object passed to axe.run in the page: a tag-type runOnly and both result types. Pure. */
export function axeRunOptions(tags: readonly string[]): AxeRunOptions {
  return { runOnly: { type: "tag", values: [...tags] }, resultTypes: ["violations", "incomplete"] };
}

/**
 * The rules a tag-type runOnly of AXE_TAGS executes: axe.getRules(AXE_TAGS) minus the rules tagged
 * "experimental", which getRules returns but runOnly does not run.
 */
export function selectedRules(): Array<{ ruleId: string; tags: string[] }> {
  return axe
    .getRules([...AXE_TAGS])
    .filter((r) => !r.tags.includes("experimental"))
    .map((r) => ({ ruleId: r.ruleId, tags: [...r.tags] }));
}

/** Version and source text of the installed axe-core package; the source is evaluated in the page. */
export function installedAxe(): { version: string; source: string } {
  return { version: axe.version, source: axe.source };
}
