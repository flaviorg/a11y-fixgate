import test from "node:test";
import assert from "node:assert/strict";
import { createPatch, parsePatch } from "diff";
import { applyEdits, assertBounded, checkCandidate, strictApply, toUnifiedDiff } from "../../src/domain/fix/bounded-patch.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import type { IndexedElement } from "../../src/domain/map/html-index.ts";
import { AppError } from "../../src/domain/errors.ts";
import type { Edit } from "../../src/contracts/fix.ts";
import { fixesPatchText } from "../../src/output/patch-file.ts";
import { readHtmlFixture } from "../helpers/fixtures.ts";

const FILE = "index.html";
const ORIGINAL = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Shop</title></head>",
  "<body>",
  '<img src="j.png">',
  '<img src="j.png">',
  '<img src="j.png">',
  '<p class="note">Note</p>',
  '<input type="text" name="q" />',
  "</body>",
  "</html>",
  "",
].join("\n");

const elements = (text: string, tag: string): IndexedElement[] => {
  const file = buildHtmlIndex({ [FILE]: text }).files[FILE]!;
  return (file.byTag[tag] ?? []).map((i) => file.elements[i]!);
};

/** An attribute insert right before the closing > or /> of the element's start tag (the fixers' shape, spec 5.5). */
function insertAttr(text: string, el: IndexedElement, name: string, value: string): Edit {
  const st = el.location.startTag;
  let at = text.slice(st.startOffset, st.endOffset).endsWith("/>") ? st.endOffset - 2 : st.endOffset - 1;
  while (text[at - 1] === " ") at--;
  return { range: { file: FILE, startOffset: at, endOffset: at }, replacement: ` ${name}="${value}"`, kind: "attribute", startTag: { file: FILE, ...st } };
}

function candidate(original: string, edits: Edit[], patched = applyEdits(original, edits)) {
  return { file: FILE, original, patched, patch: toUnifiedDiff(FILE, original, patched), edits };
}

test("[FIX-08] applyEdits splices non-overlapping edits from the end and rejects equal start offsets and overlaps with BOUNDED_PATCH", () => {
  const text = "0123456789";
  const e = (s: number, end: number, r: string): Edit => ({ range: { file: FILE, startOffset: s, endOffset: end }, replacement: r, kind: "attribute", startTag: { file: FILE, startOffset: 0, endOffset: 10 } });
  assert.equal(applyEdits(text, [e(8, 9, "X"), e(2, 2, "ab"), e(4, 6, "")]), "01ab2367X9");
  assert.equal(applyEdits(text, []), text);
  // A replacement ending where an insert starts is not an overlap.
  assert.equal(applyEdits(text, [e(2, 4, "_"), e(4, 4, "+")]), "01_+456789");
  const isBounded = (err: unknown) => err instanceof AppError && err.code === "BOUNDED_PATCH";
  assert.throws(() => applyEdits(text, [e(3, 3, "a"), e(3, 3, "b")]), isBounded);
  assert.throws(() => applyEdits(text, [e(2, 5, "a"), e(4, 6, "b")]), isBounded);
  assert.throws(() => applyEdits(text, [e(2, 5, "a"), e(3, 3, "b")]), isBounded);
  assert.throws(() => applyEdits(text, [e(5, 4, "a")]), isBounded);
  assert.throws(() => applyEdits(text, [e(9, 11, "a")]), isBounded);
  assert.throws(() => applyEdits(text, [e(1, 1, "a"), { ...e(3, 3, "b"), range: { file: "other.html", startOffset: 3, endOffset: 3 } }]), isBounded);
});

test("[FIX-08] toUnifiedDiff uses a/ and b/ source-root-relative names and strictApply reproduces the patched text", () => {
  const img = elements(ORIGINAL, "img")[1]!;
  const patched = applyEdits(ORIGINAL, [insertAttr(ORIGINAL, img, "alt", "Jacket")]);
  const patch = toUnifiedDiff("pages/index.html", ORIGINAL, patched);
  const [parsed, ...rest] = parsePatch(patch);
  assert.equal(rest.length, 0);
  assert.deepEqual([parsed!.oldFileName, parsed!.newFileName], ["a/pages/index.html", "b/pages/index.html"]);
  // jsdiff may express the middle-line change as an insert plus a delete of a neighbouring identical line (spec Appendix A).
  assert.match(patch, /^\+<img src="j.png" alt="Jacket">$/m);
  assert.equal(strictApply(ORIGINAL, patch), patched);
  // A shifted base does not apply with fuzzFactor 0, and neither does a two-file patch.
  assert.equal(strictApply(`<!-- moved -->\n${ORIGINAL}`.replace('<img src="j.png">\n<img', '<img src="k.png">\n<img'), patch), null);
  assert.equal(strictApply(ORIGINAL, patch + toUnifiedDiff("b.html", "a\n", "b\n")), null);
});

test("[FIX-08] the bounds gate accepts a one-attribute edit between two identical neighbouring <img> lines", () => {
  const middle = elements(ORIGINAL, "img")[1]!;
  const c = candidate(ORIGINAL, [insertAttr(ORIGINAL, middle, "alt", "Jacket")]);
  assert.match(c.patched, /<img src="j.png">\n<img src="j.png" alt="Jacket">\n<img src="j.png">/);
  assert.deepEqual(checkCandidate(c), { ok: true });
  assert.deepEqual(assertBounded(c.original, c.patched, c.edits.map((e) => e.range)), { ok: true });
});

test("[FIX-08] four adversarial patches are rejected: (a) touches a line outside the range, (b) does not apply, (c) touches two files, (d) rewrites the whole element instead of one attribute", () => {
  const img = elements(ORIGINAL, "img")[0]!;
  const edit = insertAttr(ORIGINAL, img, "alt", "Jacket");
  const good = applyEdits(ORIGINAL, [edit]);

  // (a) the patch also rewrites the <p> line, outside the edited range.
  const a = good.replace('<p class="note">Note</p>', '<p class="note">Free shipping</p>');
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched: a, patch: toUnifiedDiff(FILE, ORIGINAL, a), edits: [edit] }), { ok: false, reason: "out-of-range" });
  // (b) the patch was built against another base.
  const otherBase = ORIGINAL.replace("<title>Shop</title>", "<title>Store</title>");
  const b = toUnifiedDiff(FILE, otherBase, otherBase.replace('<img src="j.png">', '<img src="j.png" alt="Jacket">'));
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched: good, patch: b, edits: [edit] }), { ok: false, reason: "strict-apply-mismatch" });
  // (c) a second file rides along.
  const c = toUnifiedDiff(FILE, ORIGINAL, good) + toUnifiedDiff("evil.html", "", "<script>alert(1)</script>\n");
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched: good, patch: c, edits: [edit] }), { ok: false, reason: "patch-file-count" });
  // (d) the whole element is rewritten although the edit is one attribute insert.
  const d = ORIGINAL.replace('<img src="j.png">', '<img alt="Jacket" src="j.png">');
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched: d, patch: toUnifiedDiff(FILE, ORIGINAL, d), edits: [edit] }), { ok: false, reason: "out-of-range" });
});

test("[FIX-08] a bare-name patch (createPatch(\"index.html\", ...)) fails item 1", () => {
  const img = elements(ORIGINAL, "img")[0]!;
  const edit = insertAttr(ORIGINAL, img, "alt", "Jacket");
  const patched = applyEdits(ORIGINAL, [edit]);
  const bare = createPatch(FILE, ORIGINAL, patched);
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched, patch: bare, edits: [edit] }), { ok: false, reason: "patch-file-names" });
  // Names for another file fail too.
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched, patch: toUnifiedDiff("other.html", ORIGINAL, patched), edits: [edit] }), { ok: false, reason: "patch-file-names" });
  assert.deepEqual(checkCandidate({ file: FILE, original: ORIGINAL, patched, patch: "not a patch", edits: [edit] }), { ok: false, reason: "patch-file-count" });
});

test("[FIX-08] an element-insert other than <title> fails item 4, and so does an attribute replacement containing \">\"", () => {
  const head = elements(ORIGINAL, "head")[0]!;
  const at = head.location.startTag.endOffset;
  const insert = (replacement: string): Edit => ({ range: { file: FILE, startOffset: at, endOffset: at }, replacement, kind: "element-insert", startTag: { file: FILE, ...head.location.startTag } });
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [insert("<title>Orbit Outfitters</title>")])), { ok: true });
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [insert("<script>alert(1)</script>")])), { ok: false, reason: "element-insert-not-title" });
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [insert(`<title>${"x".repeat(121)}</title>`)])), { ok: false, reason: "element-insert-not-title" });
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [insert("<title>a\nb</title>")])), { ok: false, reason: "element-insert-not-title" });

  const img = elements(ORIGINAL, "img")[0]!;
  for (const value of ['x"><script>alert(1)</script', "a > b", "a\nb", "a<b"]) {
    assert.deepEqual(checkCandidate(candidate(ORIGINAL, [insertAttr(ORIGINAL, img, "alt", value)])), { ok: false, reason: "attribute-markup" }, value);
  }
  // Escaped forms are fine.
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [insertAttr(ORIGINAL, img, "alt", "Sale: &quot;shop&quot; &amp; more &gt; less")])), { ok: true });
  // Replacing an existing attribute within its own range keeps the rest of the tag.
  const html = elements(ORIGINAL, "html")[0]!;
  const lang = html.location.attrs["lang"]!;
  const replace: Edit = { range: { file: FILE, ...lang }, replacement: 'lang="pt-BR"', kind: "attribute", startTag: { file: FILE, ...html.location.startTag } };
  const replaced = candidate(ORIGINAL, [replace]);
  assert.match(replaced.patched, /<html lang="pt-BR">/);
  assert.deepEqual(checkCandidate(replaced), { ok: true });
  // An attribute edit outside its start tag (here inside the element's text) fails item 4.
  const p = elements(ORIGINAL, "p")[0]!;
  const outside: Edit = { ...insertAttr(ORIGINAL, p, "title", "x"), range: { file: FILE, startOffset: p.location.startTag.endOffset + 1, endOffset: p.location.startTag.endOffset + 1 } };
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [outside])), { ok: false, reason: "attribute-outside-start-tag" });
});

test("[FIX-08] item 4 caps a candidate at 3 ranges in one file, and the patched text must be exactly the edits", () => {
  const imgs = elements(ORIGINAL, "img");
  const p = elements(ORIGINAL, "p")[0]!;
  const four = [...imgs.map((el) => insertAttr(ORIGINAL, el, "alt", "x")), insertAttr(ORIGINAL, p, "id", "n")];
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, four.slice(0, 3))), { ok: true });
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, four)), { ok: false, reason: "too-many-ranges" });
  const elsewhere: Edit = { ...four[0]!, range: { ...four[0]!.range, file: "other.html" } };
  assert.deepEqual(checkCandidate({ ...candidate(ORIGINAL, [four[0]!]), edits: [elsewhere] }), { ok: false, reason: "multiple-files" });
  // Same range, different bytes: what is written must be what the edits say.
  const edit = four[0]!;
  const sneaky = ORIGINAL.slice(0, edit.range.startOffset) + "><script>alert(1)</script" + ORIGINAL.slice(edit.range.endOffset);
  assert.deepEqual(checkCandidate(candidate(ORIGINAL, [edit], sneaky)), { ok: false, reason: "edits-mismatch" });
});

test("[RF-3] CRLF and a BOM outside the edited range are preserved and the patch strict-applies", () => {
  const original = readHtmlFixture("crlf-bom.html");
  const img = buildHtmlIndex({ [FILE]: original }).files[FILE]!;
  const el = img.elements[img.byTag["img"]![0]!]!;
  const input = img.elements[img.byTag["input"]![0]!]!;
  const c = candidate(original, [insertAttr(original, el, "width", "10"), insertAttr(original, input, "id", "mail")]);
  assert.deepEqual(checkCandidate(c), { ok: true });
  assert.equal(c.patched.startsWith("﻿"), true);
  assert.equal(c.patched.split("\r\n").length, original.split("\r\n").length);
  assert.match(c.patched, /<IMG SRC=images\/a\.png alt='A photo' width="10">\r\n<input type="email" NAME="mail" id="mail" \/>\r\n/);
});

test("[FIX-08] assertBounded compares prefix, gaps and tail around merged ranges", () => {
  const text = "aaaa<x>bbbb<y>cccc";
  const r = (s: number, e: number) => ({ file: FILE, startOffset: s, endOffset: e });
  assert.deepEqual(assertBounded(text, "aaaa<x k>bbbb<y j>cccc", [r(6, 6), r(13, 13)]), { ok: true });
  assert.deepEqual(assertBounded(text, "aaaa<x k>bbbB<y j>cccc", [r(6, 6), r(13, 13)]), { ok: false, reason: "out-of-range" });
  assert.deepEqual(assertBounded(text, "aaaa<x k>bbbb<y j>ccc", [r(6, 6), r(13, 13)]), { ok: false, reason: "out-of-range" });
  assert.deepEqual(assertBounded(text, "Aaaa<x k>bbbb<y>cccc", [r(6, 6)]), { ok: false, reason: "out-of-range" });
  // Overlapping and unsorted ranges are merged first.
  assert.deepEqual(assertBounded(text, "aaaaZZbbbb<y>cccc", [r(5, 7), r(4, 6)]), { ok: true });
  assert.deepEqual(assertBounded(text, text, []), { ok: true });
  assert.deepEqual(assertBounded(text, text + "!", []), { ok: false, reason: "out-of-range" });
});

// Task 30: the combined fixes.patch as written to disk (OUT-02, P-11).

test("[OUT-02] fixes.patch has one diff per touched file with repo-root-relative a/ and b/ names, and each strict-applies after mapping the names back to source-root-relative ones", () => {
  const baselineFiles = { "index.html": ORIGINAL, "about/team.html": ORIGINAL.replace("Shop", "Team"), "untouched.html": ORIGINAL };
  const combinedFiles: Record<string, string> = {
    "index.html": ORIGINAL.replace('<html lang="en">', "<html>").replace("<html>", '<html lang="fr">'),
    "about/team.html": ORIGINAL.replace("Shop", "Team").replace('<p class="note">', '<p class="note" id="n">'),
  };
  const text = fixesPatchText({ baselineFiles, combinedFiles, writtenFiles: {} }, "/repo/public", "/repo");
  assert.ok(text !== null);
  const patches = parsePatch(text);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map((p) => [p.oldFileName, p.newFileName]), [
    ["a/public/about/team.html", "b/public/about/team.html"],
    ["a/public/index.html", "b/public/index.html"],
  ]);
  const chunks = text.split(/(?=^=+\n--- a\/)/m);
  assert.equal(chunks.length, 2);
  for (const [i, p] of patches.entries()) {
    const rel = p.oldFileName!.replace(/^a\/public\//, "");
    assert.equal(strictApply(baselineFiles[rel as keyof typeof baselineFiles]!, chunks[i]!), combinedFiles[rel]);
  }
  assert.equal(text.includes("untouched.html"), false);
  // A file outside the repository root is named relative to the source root.
  const outside = fixesPatchText({ baselineFiles, combinedFiles, writtenFiles: {} }, "/elsewhere/site", "/repo")!;
  assert.match(outside, /--- a\/index\.html\n\+\+\+ b\/index\.html/);
});

test("[RF-1] [P-11] with zero included fixes there is no patch text", () => {
  assert.equal(fixesPatchText({ baselineFiles: { "index.html": ORIGINAL }, combinedFiles: {}, writtenFiles: {} }, "/repo", "/repo"), null);
  // A combined file equal to its base is not a change either.
  assert.equal(fixesPatchText({ baselineFiles: { "index.html": ORIGINAL }, combinedFiles: { "index.html": ORIGINAL }, writtenFiles: {} }, "/repo", "/repo"), null);
});

test("[OUT-05] after a write the patch starts from the written content, so it holds only what was left", () => {
  const written = ORIGINAL.replace('<html lang="en">', '<html lang="fr">');
  const combined = written.replace('<p class="note">', '<p class="note" aria-label="x">');
  const text = fixesPatchText({ baselineFiles: { "index.html": ORIGINAL }, combinedFiles: { "index.html": combined }, writtenFiles: { "index.html": written } }, "/repo", "/repo")!;
  assert.equal(strictApply(written, text), combined);
  assert.equal(text.includes("lang="), false, "the written lang fix is not in the patch");
});
