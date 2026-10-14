// The report passes the tool's own audit (CS-6, OUT-01): served from its out dir in a real Chromium, 0 violations and
// 0 keyboard findings, despite its own strict Content-Security-Policy, and every <img> loads. Needs a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { createLlmStrategyRunner } from "../../src/app/llm-strategies.ts";
import { createPlaywrightRunner } from "../../src/browser/playwright-runner.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import { analyzeSnapshot } from "../../src/domain/findings.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createFakeProvider } from "../../src/llm/fake-provider.ts";
import { writeOutputs } from "../../src/output/write-outputs.ts";
import { browserPathOrSkip } from "../helpers/browser.ts";
import { FIXTURE_ROOT, runAuditOnFixtureCopy } from "../helpers/fixtures.ts";
import { emptyResult } from "../helpers/results.ts";
import { serveCopy } from "../helpers/serve.ts";
import { tmpDir } from "../helpers/tmp.ts";

const quiet = createLogger({ component: "runner", level: "error", write: () => {} });

async function auditReport(exe: string, outDir: string) {
  const served = await serveCopy(outDir);
  const runner = createPlaywrightRunner({ executablePath: exe, outDir: null, logger: quiet });
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const snapshot = await runner.audit(served.target("/report.html"), DEFAULT_PROFILE);
    const findings = analyzeSnapshot(snapshot, buildHtmlIndex({}), null, DEFAULT_PROFILE);
    // Load the report once more in a plain page to read the images and any CSP violation (the tool's own context blocks nothing here).
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(served.url + "/report.html", { waitUntil: "load" });
    const images = await page.evaluate(() => [...document.images].map((i) => ({ src: i.getAttribute("src"), alt: i.alt, naturalWidth: i.naturalWidth })));
    const scripts = await page.evaluate(() => document.querySelectorAll("script").length);
    await context.close();
    return { snapshot, findings, images, problems, scripts };
  } finally {
    await browser.close();
    await runner.close();
    await served.close();
  }
}

test("[OUT-01] [CS-6] report.html served from the out dir audits to 0 violations and 0 keyboard findings, and every <img> has naturalWidth > 0", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, "..", "llm", "storefront.json"), "utf8"));
  const run = await runAuditOnFixtureCopy(t, exe, {
    llm: (root) => createLlmStrategyRunner({ provider: createFakeProvider({ fixture, strict: true }), sourceRoot: root, pagePath: "/", logger: quiet }),
  });
  assert.deepEqual(readdirSync(join(run.out, "screenshots")).sort(), ["page.after.png", "page.png"]);
  writeOutputs(run, { outDir: run.out, sourceRoot: run.root, repoRoot: dirname(run.root), sarif: true });

  const { snapshot, findings, images, problems, scripts } = await auditReport(exe, run.out);
  const violations = findings.filter((f) => f.source === "axe" && f.status === "violation");
  assert.deepEqual(violations.map((f) => `${f.ruleId} ${f.node.selector}`), [], "the report has no axe violation");
  assert.deepEqual(findings.filter((f) => f.source === "keyboard").map((f) => `${f.ruleId} ${f.node.selector}`), [], "the report has no keyboard finding");
  assert.deepEqual(findings.map((f) => `${f.ruleId} ${f.status}`), [], "not even a needs-review item");
  assert.ok(snapshot.traversal.steps.length > 20, "the traversal walked the report (nav links, details and scrollable regions)");
  assert.equal(snapshot.title, "a11y-fixgate report: /");
  assert.equal(snapshot.lang, "en");
  assert.deepEqual(images.map((i) => i.src), ["screenshots/page.png", "screenshots/page.after.png"]);
  for (const img of images) assert.ok(img.naturalWidth > 0, `${img.src} loaded`);
  assert.equal(scripts, 0);
  assert.deepEqual(problems, [], "no console error, CSP violation or page error");
  // The report page has pre blocks that scroll, and every one is reachable by keyboard (the axe rule passed above).
  assert.ok(snapshot.axe.passesCount > 20);
});

test("[RF-1] [CS-6] the report of a clean page also passes the tool's own audit", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const out = tmpDir(t, "a11y-clean-report-");
  const result = emptyResult();
  writeOutputs(result, { outDir: out, sourceRoot: result.config.sourceRoot, repoRoot: "/work", sarif: true });
  const { findings, problems } = await auditReport(exe, out);
  assert.deepEqual(findings.map((f) => `${f.ruleId} ${f.status} ${f.node.selector}`), []);
  assert.deepEqual(problems, []);
});

test("[CS-6] the self-audit has teeth: a report whose <pre> blocks lose tabindex and whose images lose alt is flagged", async (t) => {
  const exe = browserPathOrSkip(t);
  if (!exe) return;
  const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, "..", "llm", "storefront.json"), "utf8"));
  const run = await runAuditOnFixtureCopy(t, exe, {
    llm: (root) => createLlmStrategyRunner({ provider: createFakeProvider({ fixture, strict: true }), sourceRoot: root, pagePath: "/", logger: quiet }),
  });
  writeOutputs(run, { outDir: run.out, sourceRoot: run.root, repoRoot: dirname(run.root), sarif: false });
  const file = join(run.out, "report.html");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(' tabindex="0"', "").replaceAll(/ alt="[^"]*"/g, ""));
  const { findings } = await auditReport(exe, run.out);
  const rules = new Set(findings.map((f) => f.ruleId));
  assert.ok(rules.has("scrollable-region-focusable"), [...rules].join());
  assert.ok(rules.has("image-alt"), [...rules].join());
});
