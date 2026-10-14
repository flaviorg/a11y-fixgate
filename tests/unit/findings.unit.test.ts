import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSnapshot, findingSetOf } from "../../src/domain/findings.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { fingerprintOf } from "../../src/domain/verify/fingerprint.ts";
import { findingSchema, isUnmapped } from "../../src/contracts/finding.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { readFixture } from "../helpers/fixtures.ts";
import { loadRecording } from "../helpers/recorded.ts";
import { axeResult, makeNode, makeSnapshot } from "../helpers/snapshots.ts";

const FILES = {
  "index.html": [
    "<!doctype html>",
    "<html>",
    "<head></head>",
    "<body>",
    '<img src="a.png">',
    '<p class="note" style="color:#aaa">Note</p>',
    '<button class="x"></button>',
    "</body>",
    "</html>",
    "",
  ].join("\n"),
};

function scripted() {
  const img = makeNode({ selector: '["img"]', tag: "img", attrs: { src: "a.png" } });
  const p = makeNode({ selector: '[".note"]', tag: "p", attrs: { class: "note", style: "color:#aaa" }, text: "Note" });
  const injected = makeNode({ selector: '["#late"]', tag: "button", attrs: { id: "late" }, domTagIndex: 1, domTagCount: 2 });
  const realButton = makeNode({ selector: '[".x"]', tag: "button", attrs: { class: "x" }, domTagIndex: 0, domTagCount: 2 });
  const node = (target: string) => ({ target: [target], html: "<x>", failureSummary: `Fix ${target}`, any: [{ id: "c", data: { ratio: 2 } }], all: [], none: [] });
  return makeSnapshot({
    axe: {
      violations: [
        axeResult({ id: "image-alt", impact: "critical", tags: ["wcag2a", "wcag111"], nodes: [node("img")] }),
        axeResult({ id: "button-name", impact: "critical", tags: ["wcag2a", "wcag412"], nodes: [node("#late"), node(".x")] }),
      ],
      incomplete: [axeResult({ id: "color-contrast", impact: "serious", tags: ["wcag2aa", "wcag143"], nodes: [node(".note")] })],
      passesCount: 0,
      inapplicableCount: 0,
      toolOptions: {},
    },
    nodes: { '["img"]': img, '[".note"]': p, '["#late"]': injected, '[".x"]': realButton },
    traversal: {
      steps: [],
      stoppedBecause: "body",
      interactiveCandidates: [{ selector: "p.note", tag: "p", reason: "onclick", focusable: false, reached: false, hasFocusableDescendant: false }],
    },
  });
}

test("[AUD-07] analyzeSnapshot fingerprints violations and incomplete findings and keeps their status", () => {
  const snapshot = scripted();
  snapshot.nodes["p.note"] = { ...snapshot.nodes['[".note"]']!, selector: "p.note" };
  const findings = analyzeSnapshot(snapshot, buildHtmlIndex(FILES), "index.html", DEFAULT_PROFILE);
  for (const f of findings) findingSchema.parse(f);
  assert.deepEqual(
    findings.map((f) => [f.id, f.source, f.status]),
    [
      ["image-alt-1", "axe", "violation"],
      ["color-contrast-1", "axe", "incomplete"],
      ["unreachable-control-1", "keyboard", "violation"],
      ["button-name-1", "axe", "violation"],
      ["button-name-2", "axe", "violation"],
    ],
  );
  const [img, contrast, keyboard, button, injected] = findings;
  assert.equal(img!.fingerprint, fingerprintOf("image-alt", "src:index.html#img[0]"));
  assert.deepEqual([img!.wcag, img!.level, img!.impact, img!.message, img!.data], [["1.1.1"], "A", "critical", "Fix img", { ratio: 2 }]);
  assert.deepEqual([contrast!.wcag, contrast!.level], [["1.4.3"], "AA"]);
  assert.equal(contrast!.fingerprint, fingerprintOf("color-contrast", "src:index.html#p[0]"));
  assert.deepEqual([keyboard!.wcag, keyboard!.level, keyboard!.impact], [["2.1.1"], "A", "serious"]);
  assert.match(keyboard!.helpUrl, /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\//);
  assert.equal(button!.node.selector, '[".x"]');
  assert.deepEqual(injected!.location, { reason: "no-candidate" });
  assert.equal(injected!.fingerprint, fingerprintOf("button-name", 'dom:button id="late"'));
  const set = findingSetOf(findings);
  assert.deepEqual([set.violations.size, set.incomplete.size, set.keyboard.size], [3, 1, 1]);
  assert.equal(set.keyboard.has(keyboard!.fingerprint), true);
  assert.equal(set.violations.has(keyboard!.fingerprint), false);
});

test("[AUD-07] a node without a descriptor is reported as dom-only instead of crashing, and a missing impact defaults to minor", () => {
  const snapshot = makeSnapshot({
    axe: {
      violations: [axeResult({ id: "region", impact: null, tags: ["wcag2a"], nodes: [{ target: ["#gone"], html: "<div id=gone>", any: [], all: [], none: [] }] })],
      incomplete: [],
      passesCount: 0,
      inapplicableCount: 0,
      toolOptions: {},
    },
  });
  const [f] = analyzeSnapshot(snapshot, buildHtmlIndex(FILES), "index.html", DEFAULT_PROFILE);
  assert.deepEqual(f!.location, { reason: "dom-only" });
  assert.equal(f!.impact, "minor");
  assert.equal(f!.message, "");
  assert.deepEqual(f!.data, {});
  assert.equal(f!.node.tag, "unknown");
});

test("[CS-4] the storefront baseline gives 19 findings: 15 axe violations, 1 incomplete and 3 keyboard findings, ordered by source offset, with filename-safe ids", () => {
  const snapshot = loadRecording("baseline");
  const index = buildHtmlIndex({ "index.html": readFixture("index.html") });
  const findings = analyzeSnapshot(snapshot, index, "index.html", DEFAULT_PROFILE);
  assert.equal(findings.length, 19);
  const axe = findings.filter((f) => f.source === "axe");
  assert.equal(axe.filter((f) => f.status === "violation").length, 15);
  assert.equal(axe.filter((f) => f.status === "incomplete").length, 1);
  assert.equal(findings.filter((f) => f.source === "keyboard").length, 3);
  for (const f of findings) {
    findingSchema.parse(f);
    assert.match(f.id, /^[a-z0-9-]+$/);
  }
  assert.equal(new Set(findings.map((f) => f.id)).size, 19);
  // Mapped findings in (file, startOffset) order, then the one unmapped finding.
  const mapped = findings.filter((f) => !isUnmapped(f.location));
  assert.equal(mapped.length, 18);
  const offsets = mapped.map((f) => (isUnmapped(f.location) ? -1 : f.location.startOffset));
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.deepEqual(findings[18]!.location, { reason: "no-candidate" });
  assert.equal(findings[18]!.id, "label-3");
  // Ties keep snapshot order: both html findings come first, in axe order.
  assert.deepEqual(findings.slice(0, 2).map((f) => f.id), ["document-title-1", "html-has-lang-1"]);
  assert.deepEqual(
    findings.map((f) => f.id),
    [
      "document-title-1",
      "html-has-lang-1",
      "focus-obscured-1",
      "link-name-1",
      "link-name-2",
      "label-1",
      "button-name-1",
      "image-alt-1",
      "color-contrast-1",
      "image-alt-2",
      "unreachable-control-1",
      "image-alt-3",
      "color-contrast-2",
      "image-alt-4",
      "label-2",
      "target-size-1",
      "target-size-2",
      "keyboard-trap-1",
      "label-3",
    ],
  );
  const set = findingSetOf(findings);
  assert.deepEqual([set.violations.size, set.incomplete.size, set.keyboard.size], [15, 1, 3]);
});
