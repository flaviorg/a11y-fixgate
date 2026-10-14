import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../src/domain/errors.ts";
import { createScratchFactory } from "../../src/infra/scratch.ts";
import { treeSha256 } from "../../src/infra/tree-hash.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

const site = { "index.html": "<p>hi</p>", "about/team.htm": "<p>team</p>", "styles.css": "p{}", "img/a.png": new Uint8Array([1, 2]) };

test("[VER-04] a scratch copy skips symlinks and excluded dirs, write() changes only the copy, dispose() removes it, and the source tree is byte-identical (treeSha256 before equals after)", async (t) => {
  const src = tmpDir(t);
  const outside = tmpDir(t);
  writeTree(src, { ...site, "node_modules/pkg/i.js": "1", ".git/HEAD": "ref" });
  writeTree(outside, { "secret.txt": "s" });
  symlinkSync(join(outside, "secret.txt"), join(src, "link.txt"));
  symlinkSync(outside, join(src, "linkdir"));
  const before = treeSha256(src);

  const scratch = await createScratchFactory().create(src, {});
  assert.ok(scratch.root.startsWith(tmpdir()) || scratch.root.includes("a11y"), "lives under the OS temp dir");
  assert.notEqual(scratch.root, src);
  for (const rel of ["index.html", "about/team.htm", "styles.css", "img/a.png"]) assert.ok(existsSync(join(scratch.root, rel)), `${rel} is copied`);
  for (const rel of ["node_modules", ".git", "link.txt", "linkdir"]) assert.equal(existsSync(join(scratch.root, rel)), false, `${rel} is not copied`);
  assert.deepEqual(scratch.files(), { "index.html": "<p>hi</p>", "about/team.htm": "<p>team</p>" }, "files() returns the .html and .htm texts by relative posix path");

  scratch.write({ "index.html": "<p>patched</p>", "new/dir/extra.html": "<p>new</p>" });
  assert.equal(readFileSync(join(scratch.root, "index.html"), "utf8"), "<p>patched</p>");
  assert.equal(scratch.files()["new/dir/extra.html"], "<p>new</p>");
  assert.equal(readFileSync(join(src, "index.html"), "utf8"), "<p>hi</p>", "the source is untouched");
  assert.equal(treeSha256(src), before);

  scratch.dispose();
  assert.equal(existsSync(scratch.root), false);
  scratch.dispose();
  assert.equal(treeSha256(src), before);
});

test("[VER-04] write() refuses paths that leave the scratch root", async (t) => {
  const src = tmpDir(t);
  writeTree(src, site);
  const scratch = await createScratchFactory().create(src, {});
  t.after(() => scratch.dispose());
  for (const rel of ["../escape.html", "/abs.html", "a/../../escape.html", "a\\b.html"]) {
    assert.throws(() => scratch.write({ [rel]: "x" }), (e) => e instanceof AppError && e.code === "UNSAFE_PATH", `must refuse ${rel}`);
  }
});

test("[VER-04] scratch create throws SRC_TOO_LARGE above 2,000 files", async (t) => {
  const src = tmpDir(t);
  writeTree(src, { "1.html": "1", "2.html": "2", "3.html": "3" });
  const tooLarge = (e: unknown) => e instanceof AppError && e.code === "SRC_TOO_LARGE" && e.message === "Source root exceeds 2,000 files or 50 MB; narrow --src";
  await assert.rejects(createScratchFactory({ maxFiles: 2 }).create(src, {}), tooLarge);
  const ok = await createScratchFactory({ maxFiles: 3 }).create(src, {});
  ok.dispose();
  await assert.rejects(createScratchFactory({ maxBytes: 2 }).create(src, {}), tooLarge);
});

test("[VER-04] a failed create leaves no scratch directory behind", async (t) => {
  const src = tmpDir(t);
  writeTree(src, { "1.html": "1", "2.html": "2" });
  // A private TMPDIR: other test files create scratch copies in the shared tmpdir at the same time.
  const privateTmp = tmpDir(t, "a11y-private-tmp-");
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });
  assert.equal(tmpdir(), privateTmp);
  const before = new Set((await import("node:fs")).readdirSync(tmpdir()).filter((n) => n.startsWith("a11y-scratch-")));
  await assert.rejects(createScratchFactory({ maxFiles: 1 }).create(src, {}));
  const after = (await import("node:fs")).readdirSync(tmpdir()).filter((n) => n.startsWith("a11y-scratch-") && !before.has(n));
  assert.deepEqual(after, []);
});

test("[RF-2] treeSha256 and scratch copies skip an out directory inside the source root (scratch side)", async (t) => {
  const src = tmpDir(t);
  writeTree(src, { ...site, "a11y-report/report.html": "first run", "a11y-report/screenshots/page.png": "png" });
  const out = join(src, "a11y-report");
  const scratch = await createScratchFactory().create(src, { excludeAbs: [out] });
  t.after(() => scratch.dispose());
  assert.equal(existsSync(join(scratch.root, "a11y-report")), false);
  assert.equal(existsSync(join(scratch.root, "index.html")), true);
  assert.equal(treeSha256(scratch.root), treeSha256(src, { excludeAbs: [out] }), "the served copy hashes like the source with the out dir excluded");
});

test("[VER-04] a source root that is itself a symlink or is named like an excluded dir still copies", async (t) => {
  const holder = tmpDir(t);
  const real = join(holder, "reports");
  mkdirSync(real);
  writeTree(real, { "index.html": "<p>x</p>" });
  const alias = join(holder, "alias");
  symlinkSync(real, alias);
  for (const root of [real, alias]) {
    const scratch = await createScratchFactory().create(root, {});
    assert.equal(readFileSync(join(scratch.root, "index.html"), "utf8"), "<p>x</p>");
    assert.equal(lstatSync(scratch.root).isDirectory(), true);
    scratch.dispose();
  }
});

test("[VER-04] a site directory named reports is copied, so a page and assets under reports/ are served", async (t) => {
  const src = tmpDir(t);
  writeTree(src, { "index.html": "<img src=\"reports/logo.svg\" alt=\"\">", "reports/index.html": "<p>annual</p>", "reports/logo.svg": "<svg/>", "docs/reports/q1.html": "<p>q1</p>" });
  const scratch = await createScratchFactory().create(src, {});
  t.after(() => scratch.dispose());
  for (const rel of ["reports/index.html", "reports/logo.svg", "docs/reports/q1.html"]) assert.ok(existsSync(join(scratch.root, rel)), `${rel} is copied`);
  assert.equal(scratch.files()["reports/index.html"], "<p>annual</p>");
  assert.equal(treeSha256(scratch.root), treeSha256(src), "the copy hashes like the source");
});
