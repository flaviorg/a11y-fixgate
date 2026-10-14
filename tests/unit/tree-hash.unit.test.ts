import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../../src/domain/errors.ts";
import { treeSha256 } from "../../src/infra/tree-hash.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

test("[AUD-06] treeSha256 is stable for the same tree and changes when a CSS byte or an image byte changes", (t) => {
  const root = tmpDir(t);
  writeTree(root, { "index.html": "<p>x</p>", "styles.css": "body{color:#000}", "images/a.png": new Uint8Array([1, 2, 3]) });
  const before = treeSha256(root);
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.equal(treeSha256(root), before, "stable");
  writeFileSync(join(root, "styles.css"), "body{color:#001}");
  const css = treeSha256(root);
  assert.notEqual(css, before);
  writeFileSync(join(root, "images/a.png"), new Uint8Array([1, 2, 4]));
  assert.notEqual(treeSha256(root), css);
});

test("[AUD-06] treeSha256 follows the documented formula: sha256 of sorted 'path:sha256(bytes)' lines", (t) => {
  const root = tmpDir(t);
  writeTree(root, { "b.txt": "B", "a/z.txt": "Z", "a.txt": "A" });
  const lines = ["a.txt:" + sha("A"), "a/z.txt:" + sha("Z"), "b.txt:" + sha("B")].sort();
  assert.equal(treeSha256(root), sha(lines.join("\n")));
  assert.equal(treeSha256(tmpDir(t)), sha(""), "an empty tree hashes the empty string");
});

test("[AUD-06] treeSha256 does not depend on creation order, but does depend on file names", (t) => {
  const a = tmpDir(t);
  const b = tmpDir(t);
  writeTree(a, { "one.txt": "1", "two.txt": "2" });
  writeTree(b, { "two.txt": "2", "one.txt": "1" });
  assert.equal(treeSha256(a), treeSha256(b));
  renameSync(join(b, "one.txt"), join(b, "uno.txt"));
  assert.notEqual(treeSha256(a), treeSha256(b));
});

test("[AUD-06] treeSha256 ignores symlinks, node_modules and .git", (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t);
  writeTree(root, { "index.html": "<p>x</p>" });
  writeTree(outside, { "secret.txt": "s" });
  const clean = treeSha256(root);
  writeTree(root, { "node_modules/pkg/index.js": "1", ".git/HEAD": "ref" });
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  assert.equal(treeSha256(root), clean);
});

test("[AUD-06] a site directory named reports is hashed like any other directory, at the root and deeper", (t) => {
  const root = tmpDir(t);
  writeTree(root, { "index.html": "<p>x</p>" });
  const clean = treeSha256(root);
  writeTree(root, { "reports/index.html": "<p>annual reports</p>" });
  const withRootReports = treeSha256(root);
  assert.notEqual(withRootReports, clean, "a root reports/ directory is part of the site");
  writeTree(root, { "deep/reports/x.html": "r" });
  assert.notEqual(treeSha256(root), withRootReports, "a nested reports/ directory is part of the site");
});

test("[RF-2] treeSha256 and scratch copies skip an out directory inside the source root", (t) => {
  const root = tmpDir(t);
  writeTree(root, { "index.html": "<p>x</p>" });
  const out = join(root, "a11y-report");
  const clean = treeSha256(root, { excludeAbs: [out] });
  writeTree(root, { "a11y-report/report.html": "first run", "a11y-report/screenshots/page.png": "png" });
  assert.equal(treeSha256(root, { excludeAbs: [out] }), clean, "an existing out dir does not change the hash");
  assert.notEqual(treeSha256(root), clean, "without excludeAbs it would");
  mkdirSync(join(root, "elsewhere"));
  assert.equal(treeSha256(root, { excludeAbs: [out, join(root, "not-created-yet")] }), clean, "a non-existent excluded path is harmless");
});

test("[RF-2] excludeAbs matches through a symlinked spelling of the root", (t) => {
  const real = tmpDir(t);
  const holder = tmpDir(t);
  const alias = join(holder, "alias");
  symlinkSync(real, alias);
  writeTree(real, { "index.html": "x", "out/report.html": "r" });
  const clean = (() => { const r = tmpDir(t); writeTree(r, { "index.html": "x" }); return treeSha256(r); })();
  assert.equal(treeSha256(real, { excludeAbs: [join(alias, "out")] }), clean);
  assert.equal(treeSha256(alias, { excludeAbs: [join(real, "out")] }), clean);
});

test("[AUD-06] treeSha256 throws SRC_TOO_LARGE above maxFiles", (t) => {
  const root = tmpDir(t);
  writeTree(root, { "1.txt": "1", "2.txt": "2", "3.txt": "3" });
  assert.equal(typeof treeSha256(root, { maxFiles: 3 }), "string");
  assert.throws(() => treeSha256(root, { maxFiles: 2 }), (e) => e instanceof AppError && e.code === "SRC_TOO_LARGE");
});
