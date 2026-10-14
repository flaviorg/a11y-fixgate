import test from "node:test";
import assert from "node:assert/strict";
import { fnv1a64 } from "../../src/domain/hash.ts";
import { anchorOf, domKey, fingerprintOf } from "../../src/domain/verify/fingerprint.ts";
import { analyzeSnapshot } from "../../src/domain/findings.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import type { SourceLocation } from "../../src/contracts/finding.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { axeResult, makeNode, makeSnapshot } from "../helpers/snapshots.ts";

const location: SourceLocation = {
  file: "index.html",
  startOffset: 100,
  endOffset: 130,
  startTag: { startOffset: 100, endOffset: 130 },
  attrs: {},
  startLine: 9,
  startCol: 5,
  endLine: 9,
  endCol: 35,
  tagOrdinal: 1,
  method: "signature",
};

test("[VER-01] fnv1a64 matches the reference vectors", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
  assert.equal(fnv1a64("foobar"), "85944171f73967e8");
  // UTF-8 bytes, not UTF-16 code units: "é" is two bytes.
  let h = 0xcbf29ce484222325n;
  for (const byte of [0xc3, 0xa9]) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  assert.equal(fnv1a64("é"), h.toString(16).padStart(16, "0"));
  assert.match(fnv1a64("😀 any text"), /^[0-9a-f]{16}$/);
});

test("[VER-01] the same rule and anchor give the same fingerprint in violations and in incomplete; the status is not hashed", () => {
  assert.equal(fingerprintOf("color-contrast", "src:index.html#p[2]"), fnv1a64("v1|color-contrast|src:index.html#p[2]"));
  const files = { "index.html": '<!doctype html><html><head></head><body><p style="color:#aaa">x</p></body></html>' };
  const node = makeNode({ selector: '["p"]', tag: "p", attrs: { style: "color:#aaa" }, text: "x" });
  const result = axeResult({ id: "color-contrast", nodes: [{ target: ["p"], html: "<p>", any: [], all: [], none: [] }] });
  const asViolation = analyzeSnapshot(makeSnapshot({ axe: { violations: [result], incomplete: [], passesCount: 0, inapplicableCount: 0, toolOptions: {} }, nodes: { '["p"]': node } }), buildHtmlIndex(files), "index.html", DEFAULT_PROFILE);
  const asIncomplete = analyzeSnapshot(makeSnapshot({ axe: { violations: [], incomplete: [result], passesCount: 0, inapplicableCount: 0, toolOptions: {} }, nodes: { '["p"]': node } }), buildHtmlIndex(files), "index.html", DEFAULT_PROFILE);
  assert.deepEqual([asViolation[0]!.status, asIncomplete[0]!.status], ["violation", "incomplete"]);
  assert.equal(asViolation[0]!.fingerprint, asIncomplete[0]!.fingerprint);
  assert.equal(asViolation[0]!.fingerprint, fingerprintOf("color-contrast", "src:index.html#p[0]"));
});

test("[VER-01] the selector is irrelevant: #email and input[aria-label=...] with the same source anchor fingerprint equally", () => {
  const before = makeNode({ selector: '["#email"]', tag: "input", attrs: { type: "email", name: "email" }, domTagIndex: 1, domTagCount: 4 });
  const after = makeNode({ selector: '["input[aria-label=\\"Newsletter email\\"]"]', tag: "input", attrs: { type: "email", name: "email", "aria-label": "Newsletter email" }, domTagIndex: 1, domTagCount: 4 });
  assert.equal(anchorOf(location, before), "src:index.html#input[1]");
  assert.equal(anchorOf(location, before), anchorOf(location, after));
  assert.equal(fingerprintOf("label", anchorOf(location, before)), fingerprintOf("label", anchorOf(location, after)));
  assert.notEqual(fingerprintOf("label", anchorOf(location, before)), fingerprintOf("image-alt", anchorOf(location, before)));
});

test("[VER-01] the unmapped anchor ignores descendants: a child added under an injected form leaves the form's fingerprint unchanged", () => {
  const form = makeNode({ selector: '["form.newsletter"]', tag: "form", attrs: { class: " newsletter  wide " }, text: "Subscribe", htmlSnippet: '<form class="newsletter wide"><input id="email"><button>Subscribe</button></form>' });
  const withChild = { ...form, text: "Email Subscribe", htmlSnippet: '<form class="newsletter wide"><label for="email">Email</label><input id="email"><button>Subscribe</button></form>' };
  const unmapped = { reason: "no-candidate" as const };
  assert.equal(anchorOf(unmapped, form), 'dom:form class="newsletter wide"');
  assert.equal(anchorOf(unmapped, form), anchorOf(unmapped, withChild));
  // A start-tag change does change it.
  assert.notEqual(anchorOf(unmapped, form), anchorOf(unmapped, { ...form, attrs: { class: "newsletter", hidden: "" } }));
  // Long start tags are cut at 200 chars after "dom:".
  const long = anchorOf(unmapped, makeNode({ tag: "div", attrs: { "data-x": "y".repeat(400) } }));
  assert.equal(long.length, "dom:".length + 200);
});

test("[VER-01] domKey is <tag>[<domTagIndex>]", () => {
  assert.equal(domKey(makeNode({ tag: "input", domTagIndex: 3, domTagCount: 4 })), "input[3]");
});
