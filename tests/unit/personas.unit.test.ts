// Persona impact catalog (spec 5.7; OUT-06): deterministic, no LLM.
import test from "node:test";
import assert from "node:assert/strict";
import axe from "axe-core";
import type { Finding } from "../../src/contracts/finding.ts";
import { AXE_TAGS } from "../../src/contracts/snapshot.ts";
import { CATALOG, CATEGORY_FALLBACKS, PERSONAS, resolveEntry } from "../../src/domain/personas/catalog.ts";
import { blockedTable, impactFor } from "../../src/domain/personas/impact.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";
import { makeNode } from "../helpers/snapshots.ts";

const BASIS = "https://www.w3.org/WAI/WCAG22/Understanding/";
const selectedRules = () => axe.getRules([...AXE_TAGS]).filter((r) => !r.tags.includes("experimental"));

function finding(overrides: Partial<Finding> & { ruleId: string }): Finding {
  return {
    id: `${overrides.ruleId}-1`,
    source: "axe",
    status: "violation",
    impact: "serious",
    wcag: [],
    level: "A",
    help: "",
    helpUrl: "",
    message: "",
    node: makeNode({ tag: "img" }),
    location: { reason: "no-candidate" },
    fingerprint: "0123456789abcdef" as Finding["fingerprint"],
    data: {},
    ...overrides,
  };
}

test("[OUT-06] every catalog entry has a basis URL under the WCAG 2.2 Understanding pages, and every selected axe rule resolves to a specific or category entry", () => {
  const entries = [...Object.values(CATALOG), ...Object.values(CATEGORY_FALLBACKS)];
  assert.ok(entries.length >= 20);
  for (const entry of entries) {
    assert.ok(entry.basis.startsWith(BASIS) && entry.basis.endsWith(".html"), `${entry.rule}: ${entry.basis}`);
    assert.deepEqual(Object.keys(entry.personas).sort(), [...PERSONAS].sort());
    for (const persona of PERSONAS) {
      const p = entry.personas[persona];
      assert.ok([0, 1, 2, 3].includes(p.severity), `${entry.rule}/${persona}`);
      assert.ok(p.template.length > 10);
    }
  }
  // Every rule of spec 5.5 has its own entry, with the three keyboard checks.
  for (const id of ["html-has-lang", "document-title", "label", "image-alt", "button-name", "link-name", "color-contrast", "target-size", "label-content-name-mismatch", "duplicate-id-aria", "keyboard-trap", "unreachable-control", "focus-obscured"]) {
    assert.ok(CATALOG[id], `missing specific entry for ${id}`);
  }
  const rules = selectedRules();
  assert.equal(rules.length, 66);
  for (const rule of rules) {
    const resolved = resolveEntry(rule.ruleId, rule.tags);
    assert.notEqual(resolved.source, "generic", `${rule.ruleId} resolves only to the generic entry`);
  }
});

test("[OUT-06] a rule without an entry of its own uses the fallback of its cat.* tag", () => {
  const resolved = resolveEntry("aria-valid-attr", ["cat.aria", "wcag2a", "wcag412"]);
  assert.equal(resolved.source, "category");
  assert.equal(resolved.entry.rule, "cat.aria");
  assert.equal(resolveEntry("image-alt", ["cat.text-alternatives"]).source, "specific");
  assert.equal(resolveEntry("made-up-rule", []).source, "generic");
});

test("[OUT-06] impactFor renders the templates with the finding data without calling the LLM", () => {
  const img = finding({ ruleId: "image-alt", node: makeNode({ tag: "img", attrs: { src: "images/jacket.png" }, htmlSnippet: '<img src="images/jacket.png">' }) });
  const impacts = impactFor(img, ["cat.text-alternatives"]);
  assert.deepEqual(impacts.map((i) => i.persona).sort(), [...PERSONAS].sort());
  const sr = impacts.find((i) => i.persona === "screen-reader")!;
  assert.equal(sr.severity, 3);
  assert.match(sr.text, /jacket\.png/);
  assert.match(sr.text, /\b1 image/);
  assert.doesNotMatch(sr.text, /[{}]/);

  const contrast = finding({ ruleId: "color-contrast", node: makeNode({ tag: "p", text: "Free returns" }), data: { contrastRatio: 2.81, expectedContrastRatio: "4.5:1" } });
  const low = impactFor(contrast, []).find((i) => i.persona === "low-vision")!;
  assert.match(low.text, /2\.81/);
  assert.doesNotMatch(low.text, /[{}]/);

  const search = finding({ ruleId: "label", node: makeNode({ tag: "input", attrs: { type: "search", name: "q" } }) });
  assert.match(impactFor(search, []).find((i) => i.persona === "screen-reader")!.text, /search field/);

  const size = finding({ ruleId: "target-size", node: makeNode({ tag: "button" }), data: { minSize: 24, width: 16, height: 16 } });
  assert.match(impactFor(size, []).find((i) => i.persona === "low-vision")!.text, /16 by 16/);

  // The count placeholder can describe a group of findings.
  assert.match(impactFor(img, [], { count: 4 }).find((i) => i.persona === "screen-reader")!.text, /\b4 images/);
});

test("[OUT-06] blockedTable counts the severity 3 entries per persona", () => {
  const findings = [
    finding({ ruleId: "image-alt" }),
    finding({ ruleId: "image-alt", id: "image-alt-2" }),
    finding({ ruleId: "keyboard-trap", source: "keyboard", status: "incomplete" }),
    finding({ ruleId: "color-contrast" }),
  ];
  const table = blockedTable(findings);
  assert.deepEqual(Object.keys(table).sort(), [...PERSONAS].sort());
  assert.equal(table["screen-reader"], 3); // two images and the trap
  assert.equal(table["keyboard-only"], 1);
  assert.equal(table["low-vision"], 0);
  assert.deepEqual(blockedTable([]), { "screen-reader": 0, "keyboard-only": 0, "low-vision": 0, cognitive: 0 });
});

test("[OUT-06] the storefront run resolves a persona impact for every one of its findings", async () => {
  const result = await runAuditRecorded("storefront");
  const tags = new Map(selectedRules().map((r) => [r.ruleId, r.tags]));
  for (const f of result.findings) {
    const impacts = impactFor(f, tags.get(f.ruleId) ?? []);
    assert.equal(impacts.length, 4, f.id);
    for (const i of impacts) assert.doesNotMatch(i.text, /[{}]/, `${f.id}/${i.persona}`);
  }
  const before = blockedTable(result.findings);
  const after = blockedTable(result.combined!.remaining);
  assert.ok(before["screen-reader"] > after["screen-reader"], "the accepted fixes lower the screen reader count");
});
