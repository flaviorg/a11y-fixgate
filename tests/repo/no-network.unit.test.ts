import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { guardNodeOptions } from "../setup/guard-options.ts";

const isGuard = (e: any) => (e?.code ?? e?.cause?.code) === "NO_NETWORK";

test("[REP-03] fetch to an external host fails with the guard error", async () => {
  await assert.rejects(fetch("https://example.com"), isGuard);
});

test("[REP-03] http.get to an external host fails with the guard error", async () => {
  const err = await new Promise((r) => http.get("http://example.org/", (res) => { res.resume(); r(null); }).on("error", r));
  assert.ok(isGuard(err));
});

for (const host of ["127.0.0.1", "::1"]) {
  test(`[REP-03] loopback ${host} is allowed for fetch`, async (t) => {
    const srv = http.createServer((_q, s) => s.end("ok")).listen(0, host);
    await once(srv, "listening");
    t.after(() => srv.close());
    const { port } = srv.address() as AddressInfo;
    assert.equal(await (await fetch(host.includes(":") ? `http://[${host}]:${port}/` : `http://${host}:${port}/`)).text(), "ok");
  });
}

test("[REP-03] child processes started with guardNodeOptions() are guarded", () => {
  const r = spawnSync(process.execPath, ["-e", "fetch('https://example.com').then(()=>console.log('open'),e=>console.log(e.code??e.cause?.code))"],
    { env: { PATH: process.env["PATH"], NODE_OPTIONS: guardNodeOptions() }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "NO_NETWORK");
});
