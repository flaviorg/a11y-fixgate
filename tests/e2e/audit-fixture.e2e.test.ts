// Real audits of the storefront and of small pages (spec 5.3, 5.15). Needs a browser (tests/helpers/browser.ts).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createPlaywrightRunner } from "../../src/browser/playwright-runner.ts";
import { installedAxe } from "../../src/browser/axe-config.ts";
import { DEFAULT_PROFILE, auditSnapshotSchema } from "../../src/contracts/snapshot.ts";
import type { AuditSnapshot } from "../../src/contracts/snapshot.ts";
import type { AuditRunner } from "../../src/domain/ports.ts";
import { AppError } from "../../src/domain/errors.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { FIXTURE_ROOT, SITES_DIR } from "../helpers/fixtures.ts";
import { serveCopy } from "../helpers/serve.ts";
import { tmpDir } from "../helpers/tmp.ts";

const quietLogger = createLogger({ component: "runner", level: "error", write: () => {} });
const runners: AuditRunner[] = [];
after(async () => {
  for (const r of runners) await r.close();
});
function runnerFor(executablePath: string, outDir: string | null = null, logger = quietLogger, axe?: { version: string; source: string }): AuditRunner {
  const runner = createPlaywrightRunner({ executablePath, outDir, logger, ...(axe ? { axe } : {}) });
  runners.push(runner);
  return runner;
}

let baseline: Promise<AuditSnapshot> | null = null;
/** The storefront baseline audit, shared by the tests of this file. */
function storefrontBaseline(exe: string): Promise<AuditSnapshot> {
  baseline ??= (async () => {
    const served = await serveCopy(FIXTURE_ROOT);
    try {
      return await runnerFor(exe).audit(served.target(), DEFAULT_PROFILE);
    } finally {
      await served.close();
    }
  })();
  return baseline;
}

const countByRule = (results: AuditSnapshot["axe"]["violations"]): Record<string, number> =>
  Object.fromEntries(results.map((r) => [r.id, r.nodes.length]));

// Part 1: isolation and axe injection (Task 8)

test("[AUD-01] axe-core is injected from the installed package by evaluation and axeVersion equals axe.version (4.14.0)", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefrontBaseline(exe);
  assert.equal(snap.axeVersion, installedAxe().version);
  assert.equal(snap.axeVersion, "4.14.0");
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.pagePath, "/");
  assert.equal(snap.lang, null);
  assert.equal(snap.title, "");
  assert.match(snap.treeSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual((snap.axe.toolOptions as { runOnly?: unknown }).runOnly, { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] });
  assert.ok(auditSnapshotSchema.safeParse(snap).success);
});

test("[AUD-01] a testEngine version different from the installed one fails with AXE_VERSION_MISMATCH", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const served = await serveCopy(join(SITES_DIR, "csp"));
  t.after(() => served.close());
  const runner = runnerFor(exe, null, quietLogger, { version: "9.9.9", source: installedAxe().source });
  await assert.rejects(runner.audit(served.target(), DEFAULT_PROFILE), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "AXE_VERSION_MISMATCH");
    assert.equal(err.message, "axe reported 4.14.0 but axe-core 9.9.9 is installed");
    return true;
  });
});

test("[AUD-01] a page that does not load fails with PAGE_LOAD_FAILED", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve())); // nothing listens on that port any more
  const target = { url: `http://127.0.0.1:${port}/`, servedRoot: join(SITES_DIR, "csp"), pagePath: "/", watch: [] };
  await assert.rejects(runnerFor(exe).audit(target, DEFAULT_PROFILE), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "PAGE_LOAD_FAILED");
    assert.equal(err.message, `Page did not load within 15 s: ${target.url}`);
    return true;
  });
});

test("[AUD-01] a page answered with HTTP 404 fails with PAGE_LOAD_FAILED naming the status, not a timeout", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const served = await serveCopy(join(SITES_DIR, "csp"));
  t.after(() => served.close());
  const target = served.target("/missing/");
  await assert.rejects(runnerFor(exe).audit(target, DEFAULT_PROFILE), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, "PAGE_LOAD_FAILED");
    assert.equal(err.message, `Page ${target.url} returned HTTP 404`);
    return true;
  });
});

test("[AUD-09] a page whose CSP forbids inline scripts is still audited: image-alt is reported on the csp page", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const served = await serveCopy(join(SITES_DIR, "csp"));
  t.after(() => served.close());
  const snap = await runnerFor(exe).audit(served.target(), DEFAULT_PROFILE);
  assert.equal(snap.title, "Strict CSP page");
  assert.equal(snap.lang, "en");
  assert.deepEqual(countByRule(snap.axe.violations), { "image-alt": 1 });
});

test("[AUD-08] only the server origin is reachable: the remote stylesheet, the image on another loopback port and the WebSocket to another loopback port are all blocked, and the other-port server records 0 requests and 0 upgrades", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  let requests = 0;
  let upgrades = 0;
  const other = createServer((_req, res) => {
    requests++;
    res.end("x");
  });
  other.on("upgrade", (_req, socket) => {
    upgrades++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
  const otherPort = (other.address() as AddressInfo).port;
  const served = await serveCopy(join(SITES_DIR, "isolation"), (dir) => {
    const file = join(dir, "index.html");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("__OTHER_PORT__", String(otherPort)));
  });
  t.after(() => served.close());

  const lines: Array<{ event: string; url?: string }> = [];
  const logger = createLogger({ component: "runner", level: "debug", write: (line) => lines.push(JSON.parse(line)) });
  const snap = await runnerFor(exe, null, logger).audit(served.target(), DEFAULT_PROFILE);
  assert.equal(snap.title, "Isolation page");
  await new Promise((resolve) => setTimeout(resolve, 200)); // let a late WebSocket attempt reach the other server, if it ever could

  const blocked = lines.filter((l) => l.event === "request_blocked").map((l) => l.url);
  const closed = lines.filter((l) => l.event === "websocket_closed").map((l) => l.url);
  assert.ok(blocked.includes("https://example.com/x.css"), `blocked: ${blocked.join(", ")}`);
  assert.ok(blocked.includes(`http://127.0.0.1:${otherPort}/pixel.png`), `blocked: ${blocked.join(", ")}`);
  assert.deepEqual(closed, [`ws://127.0.0.1:${otherPort}/socket`]);
  assert.equal(requests, 0);
  assert.equal(upgrades, 0);
});

test("[AUD-01] the storefront baseline has 15 violations across 8 rules and 1 incomplete", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefrontBaseline(exe);
  assert.deepEqual(countByRule(snap.axe.violations), {
    "html-has-lang": 1, "document-title": 1, "image-alt": 4, "label": 3, "button-name": 1, "link-name": 2, "color-contrast": 1, "target-size": 2,
  });
  assert.equal(snap.axe.violations.reduce((n, r) => n + r.nodes.length, 0), 15);
  assert.deepEqual(countByRule(snap.axe.incomplete), { "color-contrast": 1 });
  assert.deepEqual(snap.axe.incomplete[0]!.nodes[0]!.target, ["h1"]);
  const contrast = snap.axe.violations.find((r) => r.id === "color-contrast")!.nodes[0]!;
  assert.deepEqual(contrast.target, [".note"]);
  assert.equal((contrast.any[0]!.data as { contrastRatio: number }).contrastRatio, 2.81);
});

// Part 2: node descriptors, ids, screenshots, aria snapshots and watched nodes (Task 9)

test("[AUD-03] every violation and incomplete node has a descriptor keyed by its serialized target, with tag, attrs, collapsed text, domTagIndex, domTagCount, snippet and rect", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefrontBaseline(exe);
  for (const result of [...snap.axe.violations, ...snap.axe.incomplete]) {
    for (const node of result.nodes) {
      const key = JSON.stringify(node.target);
      const d = snap.nodes[key];
      assert.ok(d, `descriptor for ${key}`);
      assert.equal(d.selector, key);
      assert.match(d.tag, /^[a-z][a-z0-9-]*$/);
      assert.ok(d.domTagIndex >= 0 && d.domTagIndex < d.domTagCount, key);
      assert.ok(d.htmlSnippet.startsWith(`<${d.tag}`), key);
      assert.ok(d.htmlSnippet.length <= 400 && d.text.length <= 200, key);
      assert.ok(d.rect.width >= 0 && d.rect.height >= 0, key);
    }
  }
  const note = snap.nodes['[".note"]']!;
  assert.deepEqual(note.attrs, { class: "note", style: "color:#9a9a9a" });
  assert.equal(note.text, "Kids size. Ships in 3 days.");
  assert.equal(note.tag, "p");
  assert.equal(note.dataSource, null);
  assert.deepEqual([note.domTagIndex, note.domTagCount], [2, 4]); // p.price, p.price, p.note, the footer p
  const injected = snap.nodes['["#email"]']!;
  assert.deepEqual([injected.tag, injected.domTagIndex, injected.domTagCount], ["input", 3, 4]);
  const steps = ['[".step-down"]', '[".step-up"]'].map((k) => snap.nodes[k]!);
  assert.deepEqual(steps.map((s) => [s.tag, s.domTagIndex, s.rect.width, s.rect.height]), [["button", 1, 16, 16], ["button", 2, 16, 16]]);
  const html = snap.nodes['["html"]']!;
  assert.deepEqual([html.tag, html.domTagIndex, html.domTagCount], ["html", 0, 1]);
  assert.ok(html.htmlSnippet.length <= 400);
});

test("[AUD-03] a shadow-root node gets tag \"unknown\" and is never resolved with querySelector", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const served = await serveCopy(join(SITES_DIR, "shadow"));
  t.after(() => served.close());
  const snap = await runnerFor(exe).audit(served.target(), DEFAULT_PROFILE);
  const buttonName = snap.axe.violations.find((r) => r.id === "button-name");
  assert.ok(buttonName);
  assert.deepEqual(buttonName.nodes.map((n) => n.target), [[["#host", "button"]]]);
  const key = JSON.stringify([["#host", "button"]]);
  const d = snap.nodes[key];
  assert.ok(d);
  assert.deepEqual({ tag: d.tag, domTagIndex: d.domTagIndex, domTagCount: d.domTagCount, selector: d.selector, htmlSnippet: d.htmlSnippet }, {
    tag: "unknown", domTagIndex: -1, domTagCount: 0, selector: key, htmlSnippet: "<button></button>",
  });
  // querySelector('#host,button') would have described the host div or the light-DOM button instead.
  assert.ok(!Object.keys(snap.ariaByNode).some((k) => k.startsWith("unknown")));
});

test("[AUD-08] domIds lists every id in the live DOM, sorted, duplicates kept: the injected #email once at baseline, twice when the signup input also carries id=email", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const snap = await storefrontBaseline(exe);
  assert.deepEqual(snap.domIds, ["email", "main", "qty"]);
  const served = await serveCopy(FIXTURE_ROOT, (dir) => {
    const file = join(dir, "index.html");
    writeFileSync(file, readFileSync(file, "utf8").replace('<input type="email" name="email">', '<input type="email" name="email" id="email">'));
  });
  t.after(() => served.close());
  const dup = await runnerFor(exe).audit(served.target(), DEFAULT_PROFILE);
  assert.deepEqual(dup.domIds, ["email", "email", "main", "qty"]);
});

test("[AUD-04] a full-page screenshot is written as a PNG with non-zero width and height, and ariaByNode has an entry for every flagged light-DOM node", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const out = tmpDir(t);
  const served = await serveCopy(FIXTURE_ROOT);
  t.after(() => served.close());
  const snap = await runnerFor(exe, out).audit(served.target(), DEFAULT_PROFILE, { screenshot: "page.png" });
  assert.equal(snap.screenshots.fullPage, "screenshots/page.png");
  const file = join(out, "screenshots", "page.png");
  assert.ok(existsSync(file));
  const png = readFileSync(file);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);

  for (const result of [...snap.axe.violations, ...snap.axe.incomplete]) {
    for (const node of result.nodes) {
      const d = snap.nodes[JSON.stringify(node.target)]!;
      assert.ok(`${d.tag}[${d.domTagIndex}]` in snap.ariaByNode, `${d.tag}[${d.domTagIndex}]`);
    }
  }
  assert.match(snap.ariaByNode["button[0]"]!, /button/);
  assert.match(snap.ariaByNode["h1[0]"]!, /heading "Orbit Outfitters"/);
  assert.match(snap.ariaSnapshot, /heading "Orbit Outfitters"/);
  assert.equal(snap.ariaSnapshot.includes("[truncated"), false);

  const noShot = await storefrontBaseline(exe);
  assert.equal(noShot.screenshots.fullPage, "");
  // The screenshot must not change the DOM the audit describes: Playwright's default caret hiding left style=""
  // on every input, which changed their signatures, so the keyboard-trap on #qty became unmapped at baseline only.
  const attrsOf = (s: typeof snap) => Object.fromEntries(Object.entries(s.nodes).map(([k, d]) => [k, d.attrs]));
  assert.deepEqual(attrsOf(snap), attrsOf(noShot));
});

test("[AUD-10] a watched DOM key is captured even when the node is not flagged", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const served = await serveCopy(FIXTURE_ROOT);
  t.after(() => served.close());
  const snap = await runnerFor(exe).audit(served.target("/", ["input[2]"]), DEFAULT_PROFILE);
  const axeKeys = Object.keys(snap.nodes).filter((k) => k.startsWith("["));
  assert.equal(axeKeys.some((k) => snap.nodes[k]!.tag === "input" && snap.nodes[k]!.domTagIndex === 2), false, "#qty is not flagged by axe");
  assert.match(snap.ariaByNode["input[2]"]!, /textbox/);
  assert.match(snap.ariaByNode["input[2]"]!, /Quantity/);
  const base = await storefrontBaseline(exe);
  assert.equal("input[2]" in base.ariaByNode, false);
});
