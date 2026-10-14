import test from "node:test";
import assert from "node:assert/strict";
import { buildHtmlIndex, signatureOf, startTagSignature } from "../../src/domain/map/html-index.ts";
import type { IndexedElement, IndexedFile } from "../../src/domain/map/html-index.ts";
import { mapNode, pageTitleOf, surroundingTextOf } from "../../src/domain/map/source-map.ts";
import { pageFileFor } from "../../src/domain/map/page-file.ts";
import { analyzeKeyboard } from "../../src/domain/keyboard/analyze.ts";
import { isUnmapped } from "../../src/contracts/finding.ts";
import type { NodeDescriptor, SourceLocation, Unmapped } from "../../src/contracts/finding.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { readFixture, readHtmlFixture } from "../helpers/fixtures.ts";
import { loadRecording } from "../helpers/recorded.ts";
import { makeNode } from "../helpers/snapshots.ts";

const indexOf = (name: string): IndexedFile => buildHtmlIndex({ [name]: readHtmlFixture(name) }).files[name]!;
const elementsOf = (file: IndexedFile, tag: string): IndexedElement[] => (file.byTag[tag] ?? []).map((i) => file.elements[i]!);
const slice = (file: IndexedFile, r: { startOffset: number; endOffset: number }) => file.text.slice(r.startOffset, r.endOffset);

/** 1-based line and column of an offset, computed independently from the text. */
function lineColOf(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, col: before[before.length - 1]!.length + 1 };
}

test("[MAP-05] element, start tag and attribute offsets slice back to the exact source text, and lines and columns are 1-based", () => {
  const file = indexOf("basic.html");
  assert.equal(file.text, readHtmlFixture("basic.html"));
  const [img1, img2] = elementsOf(file, "img");
  assert.ok(img1 && img2);
  assert.equal(slice(file, img1.location), '<img src="images/a.png">');
  assert.equal(slice(file, img1.location.startTag), '<img src="images/a.png">');
  assert.equal(slice(file, img1.location.attrs["src"]!), 'src="images/a.png"');
  assert.deepEqual(img1.attrs, { src: "images/a.png" });
  assert.notEqual(img1.location.startOffset, img2.location.startOffset);
  assert.deepEqual([img1.location.tagOrdinal, img2.location.tagOrdinal], [0, 1]);
  assert.equal(img1.location.file, "basic.html");

  const [intro] = elementsOf(file, "p");
  assert.ok(intro);
  assert.equal(slice(file, intro.location), '<p class="intro">Welcome to the  basic\n    page.</p>');
  assert.equal(slice(file, intro.location.startTag), '<p class="intro">');
  assert.equal(intro.text, "Welcome to the basic page.");
  const start = lineColOf(file.text, intro.location.startOffset);
  const end = lineColOf(file.text, intro.location.endOffset);
  assert.deepEqual([intro.location.startLine, intro.location.startCol], [start.line, start.col]);
  assert.deepEqual([intro.location.endLine, intro.location.endCol], [end.line, end.col]);
  assert.equal(intro.location.startCol, 3);

  // Parents point at the nearest indexed ancestor; text is the collapsed textContent.
  const card = file.elements[img1.parent!]!;
  assert.equal(card.tag, "div");
  assert.equal(card.text, "Card text");
  assert.deepEqual(file.ids, ["main"]);
  assert.equal(elementsOf(file, "title")[0]!.text, "Basic page");
});

test("[MAP-05] offsets are UTF-16 code units: an emoji before the element shifts startOffset by 2", () => {
  const withEmoji = readHtmlFixture("emoji.html");
  const without = withEmoji.replace("😀", "");
  assert.equal(withEmoji.length - without.length, 2);
  const a = buildHtmlIndex({ "a.html": withEmoji }).files["a.html"]!;
  const b = buildHtmlIndex({ "b.html": without }).files["b.html"]!;
  const imgA = elementsOf(a, "img")[0]!;
  const imgB = elementsOf(b, "img")[0]!;
  assert.equal(imgA.location.startOffset - imgB.location.startOffset, 2);
  assert.equal(slice(a, imgA.location), '<img src="images/rocket.png">');
  assert.equal(elementsOf(a, "p")[0]!.text, "Launch 😀 day");
});

test("[RF-3] CRLF, a BOM, an uppercase IMG with an unquoted SRC and a single-quoted alt, and a self-closing input all index with exact slices", () => {
  for (const name of ["quirky.html", "crlf-bom.html"]) {
    const file = indexOf(name);
    assert.equal(file.text, readHtmlFixture(name), name);
    const img = elementsOf(file, "img")[0]!;
    assert.equal(slice(file, img.location), "<IMG SRC=images/a.png alt='A photo'>", name);
    assert.equal(slice(file, img.location.attrs["src"]!), "SRC=images/a.png", name);
    assert.equal(slice(file, img.location.attrs["alt"]!), "alt='A photo'", name);
    assert.deepEqual(img.attrs, { src: "images/a.png", alt: "A photo" }, name);
    const input = elementsOf(file, "input")[0]!;
    assert.equal(slice(file, input.location.startTag), '<input type="email" NAME="mail" />', name);
    assert.equal(slice(file, input.location.attrs["name"]!), 'NAME="mail"', name);
    // The explicit HTML element is indexed even after a BOM (the parser would otherwise see the BOM as text).
    const html = elementsOf(file, "html")[0]!;
    assert.equal(slice(file, html.location.startTag), '<HTML LANG="en">', name);
    assert.equal(slice(file, html.location.attrs["lang"]!), 'LANG="en"', name);
    assert.equal(elementsOf(file, "title")[0]!.text, "Quirky", name);
    const p = elementsOf(file, "p")[0]!;
    assert.equal(signatureOf(p.tag, p.attrs), 'p class="lead text"', name);
    // Columns count the BOM on line 1 and \r at line ends never shifts columns of the next line.
    assert.equal(img.location.startLine, 5, name);
    assert.equal(img.location.startCol, 1, name);
  }
  const bom = indexOf("crlf-bom.html");
  const doctypeLine = elementsOf(bom, "html")[0]!;
  assert.equal(doctypeLine.location.startLine, 2);
  // In the BOM file every offset is the LF file's offset plus 1 (BOM) plus one per earlier \r.
  const quirkyImg = elementsOf(indexOf("quirky.html"), "img")[0]!;
  const bomImg = elementsOf(bom, "img")[0]!;
  assert.equal(bomImg.location.startOffset, quirkyImg.location.startOffset + 1 + 4);
});

test("[MAP-05] an implicit html/head/body is not indexed and an explicit one is", () => {
  const implicit = indexOf("implicit.html");
  assert.deepEqual(Object.keys(implicit.byTag).sort(), ["img", "p"]);
  assert.equal(implicit.elements.every((e) => e.parent === null), true);
  const explicit = indexOf("basic.html");
  for (const tag of ["html", "head", "body"]) assert.equal(elementsOf(explicit, tag).length, 1, tag);
  const body = elementsOf(explicit, "body")[0]!;
  assert.equal(explicit.elements[body.parent!]!.tag, "html");
  // A BOM-only page that writes the tags explicitly keeps them explicit (checked in RF-3); a file with only a BOM and text has none.
  const bare = buildHtmlIndex({ "x.html": "﻿hello" }).files["x.html"]!;
  assert.deepEqual(bare.elements, []);
});

test("[MAP-05] signatureOf sorts attributes, trims values, collapses class whitespace and drops data-a11y-source", () => {
  assert.equal(signatureOf("img", { src: " a.png ", alt: "x" }), 'img alt="x" src="a.png"');
  assert.equal(signatureOf("p", { class: " a \n  b ", "data-a11y-source": "index.html:1:1" }), 'p class="a b"');
  assert.equal(signatureOf("br", {}), "br");
  const long = startTagSignature("div", { "data-x": "y".repeat(500) });
  assert.equal(long.length, 200);
  assert.equal(long.startsWith('div data-x="yyy'), true);
});

// ---- Task 14: mapping (spec 5.4) ----

const basicIndex = () => buildHtmlIndex({ "basic.html": readHtmlFixture("basic.html") });
const storefrontIndex = () => buildHtmlIndex({ "index.html": readFixture("index.html") });
const methodOf = (r: SourceLocation | Unmapped) => (isUnmapped(r) ? r.reason : r.method);

test("[MAP-01] data-a11y-source \"index.html:12:5\" with the same tag at that line and column maps by attribute; a mismatch gives attribute-mismatch", () => {
  const index = basicIndex();
  const img = elementsOf(index.files["basic.html"]!, "img")[1]!;
  const { startLine, startCol } = img.location;
  const node = makeNode({ tag: "img", attrs: { src: "images/a.png", "data-a11y-source": "x" }, domTagIndex: 0, domTagCount: 9, dataSource: `basic.html:${startLine}:${startCol}` });
  const mapped = mapNode(node, index, "basic.html");
  assert.equal(methodOf(mapped), "attribute");
  assert.equal(isUnmapped(mapped) ? -1 : mapped.startOffset, img.location.startOffset);
  // The attribute decides even without a page file.
  assert.equal(methodOf(mapNode(node, index, null)), "attribute");
  for (const dataSource of [`basic.html:${startLine}:${startCol + 1}`, `missing.html:${startLine}:${startCol}`, `../basic.html:${startLine}:${startCol}`, `/basic.html:${startLine}:${startCol}`]) {
    assert.deepEqual(mapNode({ ...node, dataSource }, index, "basic.html"), { reason: "attribute-mismatch" }, dataSource);
  }
  assert.deepEqual(mapNode({ ...node, tag: "p" }, index, "basic.html"), { reason: "attribute-mismatch" });
  // A value that is not file:line:col is ignored and the normal steps run.
  assert.equal(methodOf(mapNode({ ...node, dataSource: "not a location", domTagIndex: 1, domTagCount: 2 }, index, "basic.html")), "ordinal");
});

test("[MAP-02] equal DOM and source counts with a confirmed signature map by ordinal; the two identical jacket images map by ordinal to different offsets", () => {
  const index = storefrontIndex();
  const snapshot = loadRecording("baseline");
  const jacket1 = snapshot.nodes['[".card:nth-child(1) > img[src$=\\"jacket.png\\"]"]']!;
  const jacket2 = snapshot.nodes['[".card:nth-child(2) > img[src$=\\"jacket.png\\"]"]']!;
  const a = mapNode(jacket1, index, "index.html");
  const b = mapNode(jacket2, index, "index.html");
  assert.ok(!isUnmapped(a) && !isUnmapped(b));
  assert.deepEqual([a.method, b.method], ["ordinal", "ordinal"]);
  assert.notEqual(a.startOffset, b.startOffset);
  assert.deepEqual([a.tagOrdinal, b.tagOrdinal], [1, 2]);
  assert.equal(index.files["index.html"]!.text.slice(a.startOffset, a.endOffset), '<img src="images/jacket.png">');
  // Equal counts but a different signature at that ordinal falls through to the signature step.
  const basic = basicIndex();
  const moved = makeNode({ tag: "button", attrs: { class: "go" }, text: "Send", domTagIndex: 0, domTagCount: 1 });
  assert.equal(methodOf(mapNode(moved, basic, "basic.html")), "ordinal");
  assert.equal(methodOf(mapNode({ ...moved, attrs: { class: "stop" } }, basic, "basic.html")), "no-candidate");
});

test("[MAP-03] when a script injects a node of the same tag, ordinal fails page-wide and the signature maps; the injected input gives no-candidate; two identical candidates give ambiguous; the text tie-breaker applies only to non-empty text", () => {
  const index = storefrontIndex();
  const snapshot = loadRecording("baseline");
  const search = snapshot.nodes['["input[type=\\"search\\"]"]']!;
  const injected = snapshot.nodes['["#email"]']!;
  assert.equal(search.domTagCount, 4);
  assert.equal(methodOf(mapNode(search, index, "index.html")), "signature");
  assert.deepEqual(mapNode(injected, index, "index.html"), { reason: "no-candidate" });

  const basic = basicIndex();
  // Two identical <img> and a DOM count that differs from the source: the signature has two candidates.
  const img = makeNode({ tag: "img", attrs: { src: "images/a.png" }, domTagIndex: 1, domTagCount: 3 });
  assert.deepEqual(mapNode(img, basic, "basic.html"), { reason: "ambiguous" });
  // Two plain <p> differ only by text: non-empty text breaks the tie, empty text does not.
  const p = makeNode({ tag: "p", text: "Other text", domTagIndex: 0, domTagCount: 5 });
  const byText = mapNode(p, basic, "basic.html");
  assert.equal(methodOf(byText), "signature");
  assert.equal(isUnmapped(byText) ? "" : basic.files["basic.html"]!.text.slice(byText.startOffset, byText.endOffset), "<p>Other text</p>");
  assert.deepEqual(mapNode({ ...p, text: "" }, basic, "basic.html"), { reason: "ambiguous" });
  assert.deepEqual(mapNode({ ...p, text: "Nowhere" }, basic, "basic.html"), { reason: "no-candidate" });
  // A single signature candidate maps even when the live text changed (the tie-breaker is not a filter).
  const button = makeNode({ tag: "button", attrs: { class: "go" }, text: "Sent!", domTagIndex: 0, domTagCount: 2 });
  assert.equal(methodOf(mapNode(button, basic, "basic.html")), "signature");
  // No page file, or a page file outside the index.
  assert.deepEqual(mapNode(button, basic, null), { reason: "no-page-file" });
  assert.deepEqual(mapNode(button, basic, "other.html"), { reason: "no-page-file" });
});

test("[AUD-03] a recorded shadow-DOM target [[\"#host\",\"button\"]] gives dom-only", () => {
  // The descriptor the runner builds for axe's shadow target (src/browser/playwright-runner.ts, domOnlyDescriptor).
  const shadow: NodeDescriptor = {
    selector: JSON.stringify([["#host", "button"]]),
    tag: "unknown",
    attrs: {},
    text: "",
    domTagIndex: -1,
    domTagCount: 0,
    htmlSnippet: "<button></button>",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    dataSource: null,
  };
  assert.deepEqual(mapNode(shadow, basicIndex(), "basic.html"), { reason: "dom-only" });
  assert.deepEqual(mapNode(shadow, basicIndex(), null), { reason: "dom-only" });
});

test("[LLM-09] surroundingTextOf returns the parent's collapsed text from the source (for an image, the parent text without its own); pageTitleOf falls back to the h1", () => {
  const index = storefrontIndex();
  const snapshot = loadRecording("baseline");
  const textOf = (key: string, max = 600) => {
    const loc = mapNode(snapshot.nodes[key]!, index, "index.html");
    assert.ok(!isUnmapped(loc), key);
    return surroundingTextOf(loc, index, max);
  };
  assert.equal(textOf('["img[src$=\\"hero.png\\"]"]'), "Orbit Outfitters");
  assert.equal(textOf('[".card:nth-child(1) > img[src$=\\"jacket.png\\"]"]'), "Trail jacket $129 Add to cart");
  assert.equal(textOf('[".card:nth-child(2) > img[src$=\\"jacket.png\\"]"]'), "Trail jacket, kids $89 Kids size. Ships in 3 days.");
  assert.equal(textOf('[".card:nth-child(2) > img[src$=\\"jacket.png\\"]"]', 12), "Trail jacket");
  // A non-image element keeps its own text inside the parent's text.
  assert.equal(textOf('[".promo"]'), "Sale");
  // The injected newsletter text is not in the source, so the live DOM never leaks into the LLM input.
  assert.equal(pageTitleOf(index, "index.html"), "Orbit Outfitters");
  assert.equal(pageTitleOf(basicIndex(), "basic.html"), "Basic page");
  assert.equal(pageTitleOf(buildHtmlIndex({ "x.html": "<p>none</p>" }), "x.html"), "");
  assert.equal(pageTitleOf(buildHtmlIndex({ "x.html": "<title> </title><h1></h1><h1> Second  one </h1>" }), "x.html"), "Second one");
  assert.equal(pageTitleOf(basicIndex(), "missing.html"), "");
  // The top-level element has no parent text.
  const html = elementsOf(index.files["index.html"]!, "html")[0]!;
  assert.equal(surroundingTextOf({ ...html.location, method: "ordinal" }, index, 600), "");
});

test("[CS-4] all 19 storefront findings map as spec 5.15 predicts: ordinal 12, signature 6, 1 no-candidate", () => {
  const snapshot = loadRecording("baseline");
  const files: Record<string, string> = { "index.html": readFixture("index.html") };
  const pageFile = pageFileFor(snapshot.pagePath, (rel) => rel in files);
  assert.equal(pageFile, "index.html");
  const index = buildHtmlIndex(files);
  const methods = new Map<string, string>();
  for (const result of [...snapshot.axe.violations, ...snapshot.axe.incomplete]) {
    for (const n of result.nodes) {
      const key = JSON.stringify(n.target);
      methods.set(`${result.id} ${key}`, methodOf(mapNode(snapshot.nodes[key]!, index, "index.html")));
    }
  }
  for (const d of analyzeKeyboard(snapshot.traversal, { trapRepeats: DEFAULT_PROFILE.keyboard.trapRepeats })) {
    methods.set(`${d.ruleId} ${d.nodeKey}`, methodOf(mapNode(snapshot.nodes[d.nodeKey]!, index, "index.html")));
  }
  const expected: Array<[row: number, key: string, method: string]> = [
    [1, 'html-has-lang ["html"]', "ordinal"],
    [2, 'document-title ["html"]', "ordinal"],
    [3, 'image-alt ["img[src$=\\"hero.png\\"]"]', "ordinal"],
    [4, 'image-alt [".card:nth-child(1) > img[src$=\\"jacket.png\\"]"]', "ordinal"],
    [5, 'image-alt [".card:nth-child(2) > img[src$=\\"jacket.png\\"]"]', "ordinal"],
    [6, 'image-alt ["img[src$=\\"divider.png\\"]"]', "ordinal"],
    [7, 'label ["input[type=\\"search\\"]"]', "signature"],
    [8, 'label ["input[name=\\"email\\"]"]', "signature"],
    [9, 'label ["#email"]', "no-candidate"],
    [10, 'button-name [".cart"]', "signature"],
    [11, 'link-name [".logo"]', "ordinal"],
    [12, 'color-contrast [".note"]', "ordinal"],
    [13, 'target-size [".step-down"]', "signature"],
    [13, 'target-size [".step-up"]', "signature"],
    [14, 'color-contrast ["h1"]', "ordinal"],
    [15, "keyboard-trap #qty", "signature"],
    [16, "unreachable-control #main > div.cards:nth-of-type(1) > div.card:nth-of-type(1) > div.btn", "ordinal"],
    [17, 'link-name [".promo"]', "ordinal"],
    [18, "focus-obscured body > a.skip", "ordinal"],
  ];
  assert.equal(methods.size, 19);
  for (const [row, key, method] of expected) assert.equal(methods.get(key), method, `row ${row}: ${key}`);
  const counts: Record<string, number> = {};
  for (const m of methods.values()) counts[m] = (counts[m] ?? 0) + 1;
  assert.deepEqual(counts, { ordinal: 12, signature: 6, "no-candidate": 1 });
});
