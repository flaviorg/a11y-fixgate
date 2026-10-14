import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { AXE_TAGS, axeRunOptions, installedAxe, selectedRules } from "../../src/browser/axe-config.ts";

/**
 * The `any` check ids (with options) of each rule, read from the installed axe source.
 * axe._audit is unavailable outside a page, so the source is evaluated in a node:vm context with a
 * minimal window stub (axe only registers itself when window.getComputedStyle is a function).
 */
function anyChecksByRule(): Map<string, Array<{ id: string; attribute: string | null }>> {
  const sandbox: Record<string, unknown> = { setTimeout, clearTimeout, getComputedStyle: () => ({}), document: {} };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(installedAxe().source, sandbox);
  const axe = sandbox.axe as { _audit: { rules: Array<{ id: string; any: Array<string | { id: string; options?: { attribute?: string } }> }> } };
  const out = new Map<string, Array<{ id: string; attribute: string | null }>>();
  for (const rule of axe._audit.rules) {
    out.set(rule.id, rule.any.map((c) => (typeof c === "string" ? { id: c, attribute: null } : { id: c.id, attribute: c.options?.attribute ?? null })));
  }
  return out;
}

test("[AUD-02] the selected set is getRules(tags) minus experimental: only wcag* rules, no best-practice", () => {
  const sel = selectedRules();
  assert.equal(sel.length, 66);
  assert.ok(sel.every((r) => r.tags.some((t) => t.startsWith("wcag")) && !r.tags.includes("best-practice")));
  for (const id of ["target-size", "label-content-name-mismatch", "scrollable-region-focusable"]) assert.ok(sel.some((r) => r.ruleId === id), id);
  for (const id of ["css-orientation-lock", "p-as-heading", "table-fake-caption", "td-has-header"]) assert.ok(!sel.some((r) => r.ruleId === id), id);
  for (const id of ["region", "heading-order", "landmark-one-main"]) assert.ok(!sel.some((r) => r.ruleId === id), `${id} is best practice`);
});

test("[AUD-02] button-name, link-name, image-alt and label accept a non-empty title; label also a placeholder", () => {
  const checks = anyChecksByRule();
  for (const ruleId of ["button-name", "link-name", "image-alt", "label"]) {
    const any = checks.get(ruleId);
    assert.ok(any, ruleId);
    assert.ok(any.some((c) => c.id === "non-empty-title" && c.attribute === "title"), `${ruleId} accepts a non-empty title`);
  }
  assert.ok(checks.get("label")!.some((c) => c.id === "non-empty-placeholder" && c.attribute === "placeholder"), "label accepts a non-empty placeholder");
  for (const ruleId of ["button-name", "link-name", "image-alt"]) {
    assert.ok(!checks.get(ruleId)!.some((c) => c.id === "non-empty-placeholder"), `${ruleId} does not accept a placeholder`);
  }
});

test("[AUD-01] run options use a tag-type runOnly of the six tags and both result types", () => {
  assert.deepEqual(axeRunOptions(AXE_TAGS), {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    resultTypes: ["violations", "incomplete"],
  });
  const opts = axeRunOptions(["wcag2a"]);
  assert.deepEqual(opts.runOnly.values, ["wcag2a"]);
});

test("[AUD-01] installedAxe gives the version and source of the installed axe-core package", () => {
  const axe = installedAxe();
  assert.equal(axe.version, "4.14.0");
  assert.equal(typeof axe.source, "string");
  assert.ok(axe.source.length > 1_000_000);
});
