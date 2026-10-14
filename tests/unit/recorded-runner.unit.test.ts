import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { AppError } from "../../src/domain/errors.ts";
import { createRecordedRunner, recordingKey } from "../../src/infra/recorded-runner.ts";
import { treeSha256 } from "../../src/infra/tree-hash.ts";
import { AUDITS_DIR, FIXTURE_ROOT } from "../helpers/fixtures.ts";
import { loadRecording } from "../helpers/recorded.ts";
import { makeSnapshot } from "../helpers/snapshots.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

const HEX = (c: string) => c.repeat(64);

test("[AUD-06] recordingKey changes when the tree hash or the watch list changes, and is order-insensitive in the watch list", () => {
  const base = recordingKey(HEX("a"), []);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(recordingKey(HEX("b"), []), base);
  assert.notEqual(recordingKey(HEX("a"), ["input[1]"]), base);
  assert.equal(recordingKey(HEX("a"), ["input[1]", "a[2]"]), recordingKey(HEX("a"), ["a[2]", "input[1]"]));
  assert.notEqual(recordingKey(HEX("a"), ["input[1]", "a[2]"]), recordingKey(HEX("a"), ["input[1]"]));
});

function site(t: TestContext): string {
  const root = tmpDir(t, "a11y-site-");
  writeTree(root, { "index.html": "<!doctype html><title>x</title><p>x</p>", "styles.css": "p { color: #222222; }" });
  return root;
}

test("[AUD-06] a miss throws NO_RECORDING naming the first 12 hex chars of the tree hash and npm run fixtures:record", async (t) => {
  const root = site(t);
  const runner = createRecordedRunner(tmpDir(t, "a11y-rec-"));
  const tree = treeSha256(root);
  await assert.rejects(runner.audit({ url: "http://127.0.0.1:1/about/", servedRoot: root, pagePath: "/about/", watch: [] }, DEFAULT_PROFILE), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "NO_RECORDING");
    assert.equal(err.message, `No recorded audit for served tree sha256 ${tree.slice(0, 12)} (page /about/); run npm run fixtures:record (-- --check lists missing keys)`);
    return true;
  });
  assert.deepEqual(runner.lookups(), [{ key: recordingKey(tree, []), hit: false }]);
});

test("[AUD-06] a hit returns the recorded snapshot; the key follows any served file and the watch list", async (t) => {
  const root = site(t);
  const dir = tmpDir(t, "a11y-rec-");
  const tree = treeSha256(root);
  const key = recordingKey(tree, ["p[0]"]);
  const snapshot = makeSnapshot({ treeSha256: tree, title: "recorded" });
  writeFileSync(join(dir, `site.${key.slice(0, 12)}.json`), JSON.stringify({ recordingKey: key, label: "watched", snapshot }));
  const runner = createRecordedRunner(dir);
  const target = { url: "http://127.0.0.1:9/", servedRoot: root, pagePath: "/", watch: ["p[0]"] };
  const got = await runner.audit(target, DEFAULT_PROFILE, { screenshot: "page.png" });
  assert.equal(got.title, "recorded");
  assert.equal(got.screenshots.fullPage, "", "the recorded runner ignores the screenshot option");
  await assert.rejects(runner.audit({ ...target, watch: [] }, DEFAULT_PROFILE), /NO_RECORDING|No recorded audit/);
  writeTree(root, { "styles.css": "p { color: #000000; }" }); // a CSS byte changes the tree hash
  await assert.rejects(runner.audit(target, DEFAULT_PROFILE), /No recorded audit/);
  assert.deepEqual(runner.lookups().map((l) => l.hit), [true, false, false]);
  await runner.close();
});

test("[P-8] onMissing supplies a stand-in snapshot instead of throwing", async (t) => {
  const root = site(t);
  const seen: string[] = [];
  const runner = createRecordedRunner(tmpDir(t, "a11y-rec-"), { onMissing: (key) => (seen.push(key), makeSnapshot({ title: "stand-in" })) });
  const got = await runner.audit({ url: "http://127.0.0.1:9/", servedRoot: root, pagePath: "/", watch: [] }, DEFAULT_PROFILE);
  assert.equal(got.title, "stand-in");
  assert.deepEqual(seen, [recordingKey(treeSha256(root), [])]);
  assert.deepEqual(runner.lookups().map((l) => l.hit), [false]);
});

test("[AUD-06] a recording that does not validate, or whose key does not match its file name, is refused at load", (t) => {
  const bad = tmpDir(t, "a11y-rec-");
  writeFileSync(join(bad, "x.000000000000.json"), JSON.stringify({ recordingKey: HEX("0"), label: "x", snapshot: { ...makeSnapshot(), extra: 1 } }));
  assert.throws(() => createRecordedRunner(bad));
  const misnamed = tmpDir(t, "a11y-rec-");
  writeFileSync(join(misnamed, "x.111111111111.json"), JSON.stringify({ recordingKey: HEX("0"), label: "x", snapshot: makeSnapshot() }));
  assert.throws(() => createRecordedRunner(misnamed), /file name/);
});

test("[AUD-06] the storefront baseline is recorded under the key of the fixture tree with no watched node", async () => {
  const runner = createRecordedRunner(AUDITS_DIR);
  const snap = await runner.audit({ url: "http://127.0.0.1:9/", servedRoot: FIXTURE_ROOT, pagePath: "/", watch: [] }, DEFAULT_PROFILE);
  assert.equal(snap.treeSha256, treeSha256(FIXTURE_ROOT));
  assert.deepEqual(runner.lookups(), [{ key: recordingKey(treeSha256(FIXTURE_ROOT), []), hit: true }]);
});

test("[AUD-07] a recorded snapshot keeps axe incomplete separate from violations", () => {
  const snap = loadRecording("baseline");
  assert.deepEqual(snap.axe.incomplete.map((r) => [r.id, r.nodes.map((n) => n.target)]), [["color-contrast", [["h1"]]]]);
  const contrast = snap.axe.violations.find((r) => r.id === "color-contrast")!;
  assert.deepEqual(contrast.nodes.map((n) => n.target), [[".note"]]);
  assert.equal(snap.axe.violations.reduce((n, r) => n + r.nodes.length, 0), 15);
  assert.deepEqual([snap.screenshots.fullPage, snap.timings], ["", { loadMs: 0, axeMs: 0, keyboardMs: 0 }]);
});

test("[AUD-10] ariaByNode in recordings is keyed by DOM node key (<tag>[<n>])", () => {
  const snap = loadRecording("baseline");
  const keys = Object.keys(snap.ariaByNode);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.match(key, /^[a-z][a-z0-9-]*\[\d+\]$/);
  for (const key of ["html[0]", "img[0]", "img[3]", "input[3]", "button[0]", "a[1]", "a[2]", "p[2]", "h1[0]"]) assert.ok(key in snap.ariaByNode, key);
});
