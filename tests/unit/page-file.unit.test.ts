import test from "node:test";
import assert from "node:assert/strict";
import { pageFileFor } from "../../src/domain/map/page-file.ts";

const existsIn = (files: string[]) => (rel: string) => files.includes(rel);

test("[MAP-04] / and /index.html map to index.html; /x maps to x.html when it exists, else x/index.html; /x.html maps to x.html", () => {
  const exists = existsIn(["index.html", "about.html", "shop/index.html", "docs/guide.htm", "blog/post.html"]);
  assert.equal(pageFileFor("/", exists), "index.html");
  assert.equal(pageFileFor("/index.html", exists), "index.html");
  assert.equal(pageFileFor("/about", exists), "about.html");
  assert.equal(pageFileFor("/about.html", exists), "about.html");
  assert.equal(pageFileFor("/shop", exists), "shop/index.html");
  assert.equal(pageFileFor("/shop/", exists), "shop/index.html");
  assert.equal(pageFileFor("/docs/guide.htm", exists), "docs/guide.htm");
  assert.equal(pageFileFor("/blog/post", exists), "blog/post.html");
  // x.html wins over x/index.html when both exist.
  assert.equal(pageFileFor("/both", existsIn(["both.html", "both/index.html"])), "both.html");
});

test("[MAP-04] .., absolute paths, backslashes and missing files give no-page-file", () => {
  const exists = existsIn(["index.html", "about.html", "secret.html"]);
  const none = { reason: "no-page-file" };
  for (const p of [
    "/../secret.html",
    "/a/../secret.html",
    "/..",
    "//etc/passwd",
    "/C:/site/index.html",
    "index.html",
    "",
    "/a\\b.html",
    "/missing",
    "/missing.html",
    "/about/",
    "/a//about.html",
    "/./about.html",
  ]) {
    assert.deepEqual(pageFileFor(p, exists), none, p);
  }
  // A missing index.html is no-page-file too.
  assert.deepEqual(pageFileFor("/", existsIn([])), none);
});

test("[MAP-04] only .html and .htm files are page files", () => {
  const exists = existsIn(["data.json", "data.json.html", "page.php"]);
  assert.equal(pageFileFor("/data.json", exists), "data.json.html");
  assert.deepEqual(pageFileFor("/page.php", exists), { reason: "no-page-file" });
});
