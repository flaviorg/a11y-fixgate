import test from "node:test";
import assert from "node:assert/strict";
import { combineEdits } from "../../src/domain/verify/combine.ts";
import { applyEdits, strictApply, toUnifiedDiff } from "../../src/domain/fix/bounded-patch.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import type { IndexedElement } from "../../src/domain/map/html-index.ts";
import { fingerprintOf } from "../../src/domain/verify/fingerprint.ts";
import { AppError } from "../../src/domain/errors.ts";
import type { Edit, FixCandidate } from "../../src/contracts/fix.ts";

const FILE = "index.html";
const BASE = [
  "<!doctype html>",
  "<html>",
  "<head>",
  '<meta charset="utf-8">',
  "</head>",
  "<body>",
  "<h1>Orbit Outfitters</h1>",
  '<img src="hero.png">',
  '<p class="intro">Hello</p>',
  '<img src="jacket.png">',
  '<a href="/sale" class="promo">Sale</a>',
  '<label>Email</label><input type="email" name="email">',
  '<input id="taken" name="other">',
  "</body>",
  "</html>",
  "",
].join("\n");

const el = (tag: string, n = 0): IndexedElement => {
  const file = buildHtmlIndex({ [FILE]: BASE }).files[FILE]!;
  return file.elements[file.byTag[tag]![n]!]!;
};

function insertAttr(e: IndexedElement, name: string, value: string): Edit {
  const st = e.location.startTag;
  const at = st.endOffset - 1;
  return { range: { file: FILE, startOffset: at, endOffset: at }, replacement: ` ${name}="${value}"`, kind: "attribute", startTag: { file: FILE, ...st } };
}

function titleInsert(text: string): Edit {
  const head = el("head");
  const at = head.location.startTag.endOffset;
  return { range: { file: FILE, startOffset: at, endOffset: at }, replacement: `<title>${text}</title>`, kind: "element-insert", startTag: { file: FILE, ...head.location.startTag } };
}

function candidate(findingId: string, edits: Edit[], generatedIds: string[] = []): FixCandidate {
  const patched = applyEdits(BASE, edits);
  return {
    findingId,
    fingerprint: fingerprintOf(findingId.replace(/-\d+$/, ""), `src:${FILE}#x[${findingId.length}]`),
    plan: { strategy: "test", kind: "deterministic", edits, summary: findingId, needsHumanReview: false, reviewReason: null, generatedIds },
    patch: toUnifiedDiff(FILE, BASE, patched),
    patchedFiles: { [FILE]: patched },
    patchSha256: "0".repeat(64),
  };
}

test("[VER-05] two edits two lines apart combine into one diff per file that strict-applies to the baseline", () => {
  const a = candidate("image-alt-1", [insertAttr(el("img", 0), "alt", "Hero")]);
  const b = candidate("image-alt-2", [insertAttr(el("img", 1), "alt", "Jacket")]);
  // Applying the second baseline-built diff after the first does not work: that is why combine works on edits.
  assert.equal(strictApply(a.patchedFiles[FILE]!, b.patch), null);
  const r = combineEdits({ [FILE]: BASE }, [a, b], []);
  assert.deepEqual(r.included, ["image-alt-1", "image-alt-2"]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(Object.keys(r.files), [FILE]);
  assert.match(r.files[FILE]!, /<img src="hero.png" alt="Hero">\n<p class="intro">Hello<\/p>\n<img src="jacket.png" alt="Jacket">/);
  assert.equal(strictApply(BASE, r.diffs[FILE]!), r.files[FILE]);
  assert.equal((r.diffs[FILE]!.match(/^@@ /gm) ?? []).length, 1);
  assert.match(r.diffs[FILE]!, /^--- a\/index\.html$/m);
});

test("[VER-05] an attribute edit below an inserted <title> line combines correctly", () => {
  const title = candidate("document-title-1", [titleInsert("Orbit Outfitters")]);
  const alt = candidate("image-alt-1", [insertAttr(el("img", 0), "alt", "Hero")]);
  const r = combineEdits({ [FILE]: BASE }, [title, alt], []);
  assert.deepEqual(r.included, ["document-title-1", "image-alt-1"]);
  assert.match(r.files[FILE]!, /<head><title>Orbit Outfitters<\/title>\n/);
  assert.match(r.files[FILE]!, /<img src="hero.png" alt="Hero">/);
  assert.equal(strictApply(BASE, r.diffs[FILE]!), r.files[FILE]);
});

test("[VER-05] overlapping ranges make the later candidate an overlap conflict with the earlier finding id", () => {
  const promo = el("a");
  const href = promo.location.attrs["href"]!;
  const replaceHref: Edit = { range: { file: FILE, ...href }, replacement: 'href="/deals"', kind: "attribute", startTag: { file: FILE, ...promo.location.startTag } };
  // A second edit whose range overlaps the href range, on the same start tag.
  const overlapping: Edit = { ...replaceHref, range: { file: FILE, startOffset: href.startOffset + 2, endOffset: href.endOffset + 4 }, replacement: 'ref="/x" cl' };
  const other = candidate("image-alt-1", [insertAttr(el("img", 0), "alt", "Hero")]);
  const r = combineEdits({ [FILE]: BASE }, [other, candidate("link-name-1", [replaceHref]), candidate("link-name-2", [overlapping])], []);
  assert.deepEqual(r.included, ["image-alt-1", "link-name-1"]);
  assert.deepEqual(r.conflicts, [{ findingId: "link-name-2", with: "link-name-1", reason: "overlap" }]);
  assert.match(r.files[FILE]!, /<a href="\/deals" class="promo">/);
});

test("[VER-05] two attribute inserts into the same start tag (same offset) are an overlap conflict", () => {
  const promo = el("a");
  const r = combineEdits({ [FILE]: BASE }, [candidate("link-name-1", [insertAttr(promo, "aria-label", "Sale: shop deals")]), candidate("color-contrast-1", [insertAttr(promo, "style", "color:#767676")])], []);
  assert.deepEqual(r.included, ["link-name-1"]);
  assert.deepEqual(r.conflicts, [{ findingId: "color-contrast-1", with: "link-name-1", reason: "overlap" }]);
  // Different offsets inside one start tag still conflict: the start tag range is shared.
  const href = promo.location.attrs["href"]!;
  const replaceHref: Edit = { range: { file: FILE, ...href }, replacement: 'href="/deals"', kind: "attribute", startTag: { file: FILE, ...promo.location.startTag } };
  const r2 = combineEdits({ [FILE]: BASE }, [candidate("link-name-1", [insertAttr(promo, "aria-label", "x")]), candidate("link-name-2", [replaceHref])], []);
  assert.deepEqual(r2.conflicts, [{ findingId: "link-name-2", with: "link-name-1", reason: "overlap" }]);
});

test("[VER-05] a generated id that collides with another included candidate's id is an id-collision conflict", () => {
  const label = el("label");
  const email = el("input", 0);
  const other = el("input", 1);
  const first = candidate("label-1", [insertAttr(label, "for", "field-1"), insertAttr(email, "id", "field-1")], ["field-1"]);
  // The second candidate touches other start tags but generated the same id.
  const p = el("p");
  const second = candidate("label-2", [insertAttr(p, "data-x", "1"), insertAttr(other, "aria-describedby", "field-1")], ["field-1"]);
  const r = combineEdits({ [FILE]: BASE }, [first, second], []);
  assert.deepEqual(r.included, ["label-1"]);
  assert.deepEqual(r.conflicts, [{ findingId: "label-2", with: "label-1", reason: "id-collision" }]);
  // An id already in the file or in the live DOM collides as well.
  const inFile = candidate("label-1", [insertAttr(email, "data-y", "taken")], ["taken"]);
  const inDom = candidate("label-2", [insertAttr(p, "data-z", "email")], ["email"]);
  const r2 = combineEdits({ [FILE]: BASE }, [inFile, inDom], ["email", "main"]);
  assert.deepEqual(r2.included, []);
  assert.deepEqual(r2.conflicts, [
    { findingId: "label-1", with: "id:taken", reason: "id-collision" },
    { findingId: "label-2", with: "id:email", reason: "id-collision" },
  ]);
  assert.deepEqual([r2.files, r2.diffs], [{}, {}]);
});

test("[RF-1] combining zero candidates yields empty files, diffs and included lists", () => {
  assert.deepEqual(combineEdits({ [FILE]: BASE }, [], []), { files: {}, diffs: {}, included: [], conflicts: [] });
  assert.deepEqual(combineEdits({}, [], ["a"]), { files: {}, diffs: {}, included: [], conflicts: [] });
});

test("[VER-05] an edit for a file missing from the baseline is a programming error (BOUNDED_PATCH)", () => {
  const c = candidate("image-alt-1", [insertAttr(el("img", 0), "alt", "Hero")]);
  assert.throws(() => combineEdits({ "other.html": BASE }, [c], []), (e: unknown) => e instanceof AppError && e.code === "BOUNDED_PATCH");
});
