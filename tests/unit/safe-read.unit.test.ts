import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../../src/domain/errors.ts";
import { existsInsideRoot, readInsideRoot, sniffImageMime, writeInsideRoot } from "../../src/infra/safe-read.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

const unsafe = (e: unknown) => e instanceof AppError && e.code === "UNSAFE_PATH";

function project(t: import("node:test").TestContext) {
  const outer = tmpDir(t);
  const root = join(outer, "site");
  mkdirSync(root);
  writeTree(root, { "index.html": "<p>hi</p>", "img/a.png": "png-bytes", "sub/dir/page.html": "deep" });
  writeTree(outer, { "secret.txt": "top secret", "other/inside.txt": "other" });
  return { outer, root };
}

test("[VER-08] readInsideRoot reads a regular file inside the root, including nested paths and ./ segments", (t) => {
  const { root } = project(t);
  assert.equal(readInsideRoot(root, "index.html").toString(), "<p>hi</p>");
  assert.equal(readInsideRoot(root, "sub/dir/page.html").toString(), "deep");
  assert.equal(readInsideRoot(root, "./img//a.png").toString(), "png-bytes");
});

test("[VER-08] readInsideRoot refuses ../, absolute paths, backslashes, a symlinked file and a symlinked directory with UNSAFE_PATH", (t) => {
  const { outer, root } = project(t);
  symlinkSync(join(outer, "secret.txt"), join(root, "link.txt"));
  symlinkSync(join(outer, "other"), join(root, "linkdir"));
  symlinkSync(join(root, "index.html"), join(root, "inside-link.html"));
  const cases = ["../secret.txt", "img/../../secret.txt", join(outer, "secret.txt"), "/etc/passwd", "img\\a.png", "link.txt", "linkdir/inside.txt", "inside-link.html", "", "a\0b"];
  for (const rel of cases) assert.throws(() => readInsideRoot(root, rel), unsafe, `must refuse ${JSON.stringify(rel)}`);
  const err = (() => { try { readInsideRoot(root, "../secret.txt"); } catch (e) { return e as AppError; } })();
  assert.equal(err?.message, "Refused to read or write ../secret.txt: outside the source root or a symbolic link");
});

test("[VER-08] readInsideRoot works when the root itself is reached through a symlink", (t) => {
  const { outer, root } = project(t);
  const alias = join(outer, "alias");
  symlinkSync(root, alias);
  assert.equal(readInsideRoot(alias, "index.html").toString(), "<p>hi</p>");
});

test("[VER-08] readInsideRoot refuses files above the size cap", (t) => {
  const { root } = project(t);
  writeFileSync(join(root, "big.bin"), Buffer.alloc(101));
  assert.throws(() => readInsideRoot(root, "big.bin", { maxBytes: 100 }), unsafe);
  assert.equal(readInsideRoot(root, "big.bin", { maxBytes: 101 }).length, 101);
  writeFileSync(join(root, "huge.bin"), Buffer.alloc(2_097_153));
  assert.throws(() => readInsideRoot(root, "huge.bin"), unsafe, "default cap is 2,097,152 bytes");
});

test("[VER-08] readInsideRoot lets a missing file surface as ENOENT and refuses a directory", (t) => {
  const { root } = project(t);
  assert.throws(() => readInsideRoot(root, "nope.html"), (e: any) => e.code === "ENOENT");
  assert.throws(() => readInsideRoot(root, "img"), unsafe);
});

test("[VER-08] existsInsideRoot is true only for safe regular files", (t) => {
  const { outer, root } = project(t);
  symlinkSync(join(outer, "secret.txt"), join(root, "link.txt"));
  assert.deepEqual(
    ["index.html", "img/a.png", "missing.html", "../secret.txt", "link.txt", "img", "/etc/passwd"].map((r) => existsInsideRoot(root, r)),
    [true, true, false, false, false, false, false],
  );
});

test("[VER-08] writeInsideRoot replaces an existing regular file and refuses everything else", (t) => {
  const { outer, root } = project(t);
  symlinkSync(join(outer, "secret.txt"), join(root, "link.txt"));
  writeInsideRoot(root, "index.html", "<p>changed</p>");
  assert.equal(readFileSync(join(root, "index.html"), "utf8"), "<p>changed</p>");
  for (const rel of ["new.html", "../secret.txt", "link.txt", "/tmp/x", "img", "a\\b"]) {
    assert.throws(() => writeInsideRoot(root, rel, "x"), (e) => unsafe(e) || (e as any).code === "ENOENT", `must refuse ${rel}`);
  }
  assert.equal(readFileSync(join(outer, "secret.txt"), "utf8"), "top secret", "the outside file is untouched");
});

test("[VER-08] sniffImageMime types png, jpeg, webp and gif by magic bytes and returns null for svg text", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]);
  const gif87 = Buffer.from("GIF87a....");
  const gif89 = Buffer.from("GIF89a....");
  assert.deepEqual([png, jpeg, webp, gif87, gif89].map(sniffImageMime), ["image/png", "image/jpeg", "image/webp", "image/gif", "image/gif"]);
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImageMime(Buffer.from("RIFF....WAVEfmt ")), null, "RIFF that is not WEBP");
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from([0x89])), null);
});
