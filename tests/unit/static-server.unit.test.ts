import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { startStaticServer, staticServerFactory } from "../../src/infra/static-server.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

async function serve(t: import("node:test").TestContext, files: Record<string, string | Uint8Array>) {
  const outer = tmpDir(t);
  const root = join(outer, "site");
  mkdirSync(root);
  writeTree(root, files);
  writeTree(outer, { "secret.txt": "top secret" });
  const server = await startStaticServer({ root });
  t.after(() => server.close());
  return { outer, root, server };
}

/** A raw request: Node's http client does not normalize the path, so ../ reaches the server as written. */
function rawGet(url: string, path: string, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("[CLI-03] serves files with MIME types on 127.0.0.1 with an ephemeral port", async (t) => {
  const { server } = await serve(t, {
    "index.html": "<h1>home</h1>", "styles.css": "body{}", "app.js": "1", "data.json": "{}", "note.txt": "n", "logo.svg": "<svg/>",
    "a.png": new Uint8Array([0x89, 0x50]), "b.jpg": new Uint8Array([0xff, 0xd8]), "c.webp": new Uint8Array([1]), "d.gif": new Uint8Array([1]),
  });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const type = async (p: string) => (await fetch(server.url + p)).headers.get("content-type");
  assert.match((await type("/styles.css"))!, /^text\/css/);
  assert.match((await type("/app.js"))!, /^text\/javascript/);
  assert.match((await type("/data.json"))!, /^application\/json/);
  assert.match((await type("/note.txt"))!, /^text\/plain/);
  assert.equal(await type("/logo.svg"), "image/svg+xml");
  assert.equal(await type("/a.png"), "image/png");
  assert.equal(await type("/b.jpg"), "image/jpeg");
  assert.equal(await type("/c.webp"), "image/webp");
  assert.equal(await type("/d.gif"), "image/gif");
  const home = await fetch(server.url + "/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type")!, /^text\/html/);
  assert.equal(await home.text(), "<h1>home</h1>");
  assert.equal(await (await fetch(server.url + "/index.html?x=1#frag")).text(), "<h1>home</h1>", "query and fragment are ignored");
});

test("[CLI-03] a trailing slash serves the directory index, and /x falls back to x.html", async (t) => {
  const { server } = await serve(t, { "index.html": "root", "about/index.html": "about index", "pricing.html": "pricing" });
  assert.equal(await (await fetch(server.url + "/about/")).text(), "about index");
  assert.equal(await (await fetch(server.url + "/about")).text(), "about index");
  assert.equal(await (await fetch(server.url + "/pricing")).text(), "pricing");
  assert.equal((await fetch(server.url + "/nothing")).status, 404);
});

test("[CLI-03] returns 404 for a missing file, for ../ escapes (raw request path via http.request) and for a symlink pointing outside the root", async (t) => {
  const { outer, root, server } = await serve(t, { "index.html": "ok" });
  symlinkSync(join(outer, "secret.txt"), join(root, "leak.txt"));
  symlinkSync(outer, join(root, "leakdir"));
  assert.equal((await fetch(server.url + "/missing.css")).status, 404);
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/a/../../secret.txt", "/leak.txt", "/leakdir/secret.txt", "/%00", "/%zz"]) {
    const res = await rawGet(server.url, path);
    assert.equal(res.status, 404, `${path} must be 404`);
    assert.ok(!res.body.includes("top secret"), `${path} must not leak`);
  }
});

test("[CLI-03] a symlink that stays inside the root is served", async (t) => {
  const { root, server } = await serve(t, { "real.txt": "inside" });
  symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
  assert.equal(await (await fetch(server.url + "/alias.txt")).text(), "inside");
});

test("[CLI-03] only GET and HEAD are served, and responses are not cacheable", async (t) => {
  const { server } = await serve(t, { "index.html": "ok" });
  const post = await fetch(server.url + "/", { method: "POST", body: "x" });
  assert.equal(post.status, 405);
  const head = await rawGet(server.url, "/", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  const get = await fetch(server.url + "/");
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
});

test("[CLI-03] close() stops the server and the factory starts one per root", async (t) => {
  const outer = tmpDir(t);
  writeTree(outer, { "index.html": "factory" });
  const s = await staticServerFactory.start(outer);
  assert.equal(await (await fetch(s.url + "/")).text(), "factory");
  await s.close();
  await assert.rejects(fetch(s.url + "/"));
});
