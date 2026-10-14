// Page context and LLM strategies (spec 5.4 "Surrounding text", 5.5, 5.6 "Outer loop", 6.2 items 2, 5 and 6, 7.2;
// FIX-05, FIX-06, LLM-02, LLM-05, LLM-09, VER-08, RF-4, RF-5, CLI-01). Fake provider, scripted runner, tmp roots.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runFixLoop } from "../../src/app/fix-loop.ts";
import { altTextInputFor, controlNameInputFor, resolveImagePath } from "../../src/app/page-context.ts";
import { createLlmStrategyRunner } from "../../src/app/llm-strategies.ts";
import { auditConfigSchema } from "../../src/contracts/config.ts";
import type { NodeDescriptor } from "../../src/contracts/finding.ts";
import type { FixOutcome } from "../../src/contracts/fix.ts";
import type { AltTextInput, ControlNameInput, LlmTaskName } from "../../src/contracts/llm.ts";
import { DEFAULT_PROFILE } from "../../src/contracts/snapshot.ts";
import type { AuditSnapshot } from "../../src/contracts/snapshot.ts";
import { analyzeSnapshot } from "../../src/domain/findings.ts";
import { altTextLlm, ariaLabelLlm } from "../../src/domain/fix/fixers/llm-descriptors.ts";
import type { Strategy } from "../../src/domain/fix/types.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import type { LlmCallContext, LlmProvider } from "../../src/domain/ports.ts";
import { steppingClock } from "../../src/infra/clock.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { readInsideRoot } from "../../src/infra/safe-read.ts";
import { createScratchFactory } from "../../src/infra/scratch.ts";
import { staticServerFactory } from "../../src/infra/static-server.ts";
import { createFakeProvider } from "../../src/llm/fake-provider.ts";
import type { FakeProvider } from "../../src/llm/fake-provider.ts";
import { llmKey, promptHash } from "../../src/llm/fixture-format.ts";
import { PROMPTS } from "../../src/llm/prompts/index.ts";
import { fixContextFor } from "../helpers/fix-context.ts";
import { scriptedRunner } from "../helpers/scripted-runner.ts";
import type { ScriptedCase } from "../helpers/scripted-runner.ts";
import { axeRule, makeNode, scriptedSnapshot } from "../helpers/snapshots.ts";
import type { ScriptedRule } from "../helpers/snapshots.ts";
import { tmpDir, writeTree } from "../helpers/tmp.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body")]);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from(" jacket")]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const STORE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head><title>Mini store</title></head>",
  "<body>",
  '<header><a href="/" class="logo"><svg aria-hidden="true"></svg></a><a href="/sale" class="promo"><span aria-hidden="true">Sale</span></a></header>',
  '<div class="banner"><img src="images/hero.png"><h1>Mini store</h1></div>',
  '<div class="card"><img src="images/jacket.png"><p class="price">Trail jacket $129</p></div>',
  '<img src="images/divider.png">',
  "</body>",
  "</html>",
  "",
].join("\n");
const STORE_FILES = { "index.html": STORE, "images/hero.png": PNG, "images/jacket.png": OTHER_PNG, "images/divider.png": PNG };

const logo = (attrs: Record<string, string> = {}) => makeNode({ tag: "a", selector: "a.logo", attrs: { href: "/", class: "logo", ...attrs }, domTagIndex: 0, domTagCount: 2 });
const promo = (attrs: Record<string, string> = {}) => makeNode({ tag: "a", selector: "a.promo", attrs: { href: "/sale", class: "promo", ...attrs }, text: "Sale", domTagIndex: 1, domTagCount: 2 });
const img = (i: 0 | 1 | 2, attrs: Record<string, string> = {}) =>
  makeNode({ tag: "img", selector: `img:nth-of-type(${i + 1})`, attrs: { src: `images/${["hero", "jacket", "divider"][i]}.png`, ...attrs }, domTagIndex: i, domTagCount: 3 });

const linkName = (nodes: NodeDescriptor[]): ScriptedRule => axeRule("link-name", nodes.map((node) => ({ node })), "serious", ["wcag2a"]);
const imageAlt = (nodes: NodeDescriptor[]): ScriptedRule => axeRule("image-alt", nodes.map((node) => ({ node })), "critical", ["wcag2a"]);

/** The LLM input the strategy runner builds for the element (tag, ordinal) of a page: keys computed the same way as the runner. */
function inputFor(page: string, root: string, tag: "img" | "a", ordinal: number, role?: "link" | "button" | "textbox"): AltTextInput | ControlNameInput {
  const ctx = fixContextFor(page, { ruleId: tag === "img" ? "image-alt" : "link-name", tag, ordinal });
  return tag === "img" ? altTextInputFor(ctx, { sourceRoot: root, pagePath: "/", read: readInsideRoot }) : controlNameInputFor(ctx, role ?? "link");
}

type Scripted = { task: LlmTaskName; input: unknown; attempt?: 1 | 2; output?: unknown; error?: "timeout" | "server_error" | "invalid_json"; label?: string };
const hashes = () => Object.fromEntries(Object.values(PROMPTS).map((p) => [p.name, promptHash(p)]));
function fixtureOf(responses: Scripted[]) {
  return {
    schemaVersion: 1,
    scenario: "unit",
    promptHashes: hashes(),
    responses: responses.map((r) => ({ key: llmKey(r.task, r.input), task: r.task, label: r.label ?? "unit", input: r.input, attempt: r.attempt ?? 1, ...(r.error ? { error: r.error } : { output: r.output }) })),
  };
}

/** Wraps a provider and keeps the context of every call (the feedback of attempt 2). */
function spying(inner: FakeProvider): LlmProvider & { contexts: LlmCallContext[] } {
  const contexts: LlmCallContext[] = [];
  return {
    name: inner.name,
    contexts,
    complete(task, input, ctx) {
      contexts.push(ctx);
      return inner.complete(task, input, ctx);
    },
  };
}

type Setup = {
  page?: string;
  files?: Record<string, string | Uint8Array>;
  baseline: AuditSnapshot;
  cases: ScriptedCase[];
  responses: (root: string) => Scripted[];
  strict?: boolean;
  catalog?: Record<string, Strategy[]>;
};

async function runLoop(t: TestContext, s: Setup) {
  const root = tmpDir(t, "a11y-llm-");
  const page = s.page ?? STORE;
  writeTree(root, { ...(s.files ?? STORE_FILES), "index.html": page });
  const fake = createFakeProvider({ fixture: fixtureOf(s.responses(root)), strict: s.strict ?? true });
  const provider = spying(fake);
  const lines: Array<Record<string, unknown>> = [];
  const clock = steppingClock("2026-10-14T12:00:00.000Z");
  const logger = createLogger({ component: "loop", level: "debug", clock, write: (line) => lines.push(JSON.parse(line)) });
  const config = auditConfigSchema.parse({ sourceRoot: root, lang: "en", browser: { executablePath: null, source: "recorded" }, llm: { provider: "fake", strict: true } });
  const files = { "index.html": page };
  const index = buildHtmlIndex(files);
  const findings = analyzeSnapshot(s.baseline, index, "index.html", DEFAULT_PROFILE);
  const runner = scriptedRunner(s.cases);
  const llm = createLlmStrategyRunner({ provider, sourceRoot: root, pagePath: "/", logger });
  const result = await runFixLoop(
    { config, baseline: s.baseline, findings, baselineFiles: files, index, pageFile: "index.html", profile: DEFAULT_PROFILE, deadlineAt: clock.now().getTime() + config.deadlineMs, excludeAbs: [] },
    { runner, servers: staticServerFactory, scratch: createScratchFactory(), clock, logger, llm, ...(s.catalog ? { catalog: s.catalog } : {}) },
  );
  return { result, fake, provider, runner, lines, root, findings };
}

const idOf = (o: FixOutcome): string => ("candidate" in o ? o.candidate.findingId : o.findingId);
const statuses = (outcomes: FixOutcome[]) => outcomes.map((o) => `${idOf(o)}:${o.status}${"reason" in o ? `:${o.reason}` : ""}`);
const includes = (text: string) => (files: Record<string, string>) => files["index.html"]!.includes(text);

test("[LLM-09] the alt-text input comes from the source: surroundingText from the parent element, pageTitle from the source title or h1, image bytes from disk", (t) => {
  const root = tmpDir(t);
  writeTree(root, STORE_FILES);
  const ctx = fixContextFor(STORE, { ruleId: "image-alt", tag: "img", ordinal: 1 });
  // The live DOM text of the node never matters: only the source is read.
  ctx.finding.node.text = "changed by a script";
  const input = altTextInputFor(ctx, { sourceRoot: root, pagePath: "/", read: readInsideRoot });
  assert.deepEqual(input, {
    pageTitle: "Mini store",
    src: "images/jacket.png",
    surroundingText: "Trail jacket $129",
    insideControl: false,
    image: { mime: "image/png", bytesBase64: OTHER_PNG.toString("base64"), sha256: sha(OTHER_PNG), bytes: OTHER_PNG.length },
  });
  const noTitle = STORE.replace("<head><title>Mini store</title></head>", "<head></head>").replace("<h1>Mini store</h1>", "<h1>Orbit   Outfitters</h1>");
  const fromH1 = altTextInputFor(fixContextFor(noTitle, { ruleId: "image-alt", tag: "img", ordinal: 0 }), { sourceRoot: root, pagePath: "/", read: readInsideRoot });
  assert.deepEqual([fromH1.pageTitle, fromH1.surroundingText], ["Orbit Outfitters", "Orbit Outfitters"]);
  const divider = altTextInputFor(fixContextFor(STORE, { ruleId: "image-alt", tag: "img", ordinal: 2 }), { sourceRoot: root, pagePath: "/", read: readInsideRoot });
  assert.equal(divider.surroundingText, "Sale Mini store Trail jacket $129", "the parent of the divider is <body>");

  const name = controlNameInputFor(fixContextFor(STORE, { ruleId: "link-name", tag: "a", ordinal: 1 }), "link");
  assert.deepEqual(name, { role: "link", html: '<a href="/sale" class="promo">', surroundingText: "Sale", href: "/sale", placeholder: null, iconHints: ["promo"], pageTitle: "Mini store" });
  const icons = '<!doctype html><html><head><title>T</title></head><body><p>Cart <button class="cart  icon-btn"><i class="fa fa-cart"></i><svg class="icon"></svg></button></p></body></html>';
  const button = controlNameInputFor(fixContextFor(icons, { ruleId: "button-name", tag: "button" }), "button");
  assert.deepEqual([button.html, button.href, button.iconHints, button.surroundingText], ['<button class="cart  icon-btn">', null, ["cart", "icon-btn", "fa", "fa-cart", "icon"], "Cart"]);
});

test("[LLM-05] an image under 2 MB inside the root carries bytes, sha256 and mime; an svg image is image: null", (t) => {
  const root = tmpDir(t);
  const big = Buffer.concat([PNG, Buffer.alloc(2_097_153 - PNG.length)]);
  writeTree(root, { "images/logo.svg": SVG, "images/fake.png": "not really a png", "images/big.png": big, "images/ok.png": PNG });
  const page = (src: string) => `<!doctype html><html><head><title>T</title></head><body><img src="${src}"></body></html>`;
  const image = (src: string) => altTextInputFor(fixContextFor(page(src), { ruleId: "image-alt", tag: "img" }), { sourceRoot: root, pagePath: "/", read: readInsideRoot }).image;
  assert.deepEqual(image("images/ok.png"), { mime: "image/png", bytesBase64: PNG.toString("base64"), sha256: sha(PNG), bytes: PNG.length });
  assert.equal(image("images/logo.svg"), null, "svg is text: no bytes are sent");
  assert.equal(image("images/fake.png"), null, "the type comes from magic bytes, not the extension");
  assert.equal(image("images/big.png"), null, "more than 2 MB");
  assert.equal(image("images/missing.png"), null);
  assert.equal(image(""), null);
});

test("[VER-08] an image src of ../../outside.png, or a symlinked image, is refused and gives image: null without reading the target", (t) => {
  const outer = tmpDir(t);
  const root = join(outer, "site", "public");
  writeTree(outer, { "outside.png": PNG, "site/outside.png": PNG, "site/public/index.html": "" });
  symlinkSync(join(outer, "outside.png"), join(root, "linked.png"));
  const reads: string[] = [];
  const read: typeof readInsideRoot = (r, rel, opts) => {
    reads.push(rel);
    return readInsideRoot(r, rel, opts);
  };
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ component: "llm", level: "debug", write: (line) => lines.push(JSON.parse(line)) });
  const page = (src: string) => `<!doctype html><html><head><title>T</title></head><body><img src="${src}"></body></html>`;
  const image = (src: string, pagePath = "/") => altTextInputFor(fixContextFor(page(src), { ruleId: "image-alt", tag: "img" }), { sourceRoot: root, pagePath, read, logger }).image;
  assert.equal(image("../../outside.png"), null);
  assert.equal(image("../../../outside.png", "/a/b/"), null);
  assert.deepEqual(reads, ["outside.png", "outside.png"], "a URL cannot climb above the served root, so only root/outside.png (absent) was looked up");
  assert.equal(image("linked.png"), null);
  assert.deepEqual(lines.filter((l) => l["event"] === "image_refused").map((l) => [l["level"], l["code"], l["src"]]), [["warn", "UNSAFE_PATH", "linked.png"]]);
});

test("[RF-5] resolveImagePath: /images/x.png from /about/ gives images/x.png; img/x.png from /about/ gives about/img/x.png; x.png?v=2 gives x.png; https://cdn.example/x.png and data: give null", () => {
  const table: Array<[string, string, string | null]> = [
    ["/images/x.png", "/about/", "images/x.png"],
    ["img/x.png", "/about/", "about/img/x.png"],
    ["img/x.png", "/about", "img/x.png"],
    ["x.png?v=2", "/", "x.png"],
    ["x.png#top", "/", "x.png"],
    ["images/a%20b.png", "/", "images/a b.png"],
    ["https://cdn.example/x.png", "/", null],
    ["//cdn.example/x.png", "/", null],
    ["data:image/png;base64,iVBORw0KGgo=", "/", null],
    ["javascript:alert(1)", "/", null],
    ["", "/", null],
    ["/", "/", null],
  ];
  for (const [src, pagePath, expected] of table) assert.equal(resolveImagePath(src, pagePath), expected, `${src} from ${pagePath}`);
});

test("[LLM-02] attempt 2 after a value-gate rejection carries the gate reason as feedback (alt-is-filename)", async (t) => {
  const { result, provider, runner, lines } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [imageAlt([img(1)])] }),
    cases: [{ when: includes('alt="Green waterproof trail jacket with hood"'), snapshot: scriptedSnapshot() }],
    responses: (root) => [
      { task: "alt-text", input: inputFor(STORE, root, "img", 1), attempt: 1, output: { kind: "informative", alt: "jacket.png", reason: "file name" } },
      { task: "alt-text", input: inputFor(STORE, root, "img", 1), attempt: 2, output: { kind: "informative", alt: "Green waterproof trail jacket with hood", reason: "product photo" } },
    ],
  });
  assert.deepEqual(statuses(result.outcomes), ["image-alt-1:gate-rejected:alt-is-filename", "image-alt-1:accepted"]);
  assert.deepEqual(provider.contexts.map((c) => [c.attempt, c.feedback]), [[1, null], [2, "alt-is-filename"]]);
  assert.equal(runner.audits(), 1, "the value-gate rejection is never audited");
  assert.equal(result.llmCalls, 2);
  const rejected = result.outcomes[0]!;
  assert.ok(rejected.status === "gate-rejected");
  assert.deepEqual(rejected.status === "gate-rejected" && rejected.proposal, { kind: "informative", alt: "jacket.png", reason: "file name" });
  const calls = lines.filter((l) => l["event"] === "call");
  assert.deepEqual(calls.map((l) => [l["component"], l["task"], l["provider"], l["attempt"], l["gate"], l["reason"] ?? null]), [["llm", "alt-text", "fake", 1, "rejected", "alt-is-filename"], ["llm", "alt-text", "fake", 2, "passed", null]]);
  assert.match(String(calls[0]!["key"]), /^[0-9a-f]{64}$/);
});

test("[LLM-02] attempt 2 after an acceptance-gate rejection carries \"new-violation: label-content-name-mismatch\" as feedback", async (t) => {
  const mismatch = axeRule("label-content-name-mismatch", [{ node: promo({ "aria-label": "Shop deals" }) }], "serious", ["wcag21a"]);
  const { result, provider, runner } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [linkName([promo()])] }),
    cases: [
      { when: includes('aria-label="Shop deals"'), snapshot: scriptedSnapshot({ violations: [mismatch] }) },
      { when: includes('aria-label="Sale: shop deals"'), snapshot: scriptedSnapshot() },
    ],
    responses: (root) => [
      { task: "control-name", input: inputFor(STORE, root, "a", 1), attempt: 1, output: { name: "Shop deals", reason: "promo link" } },
      { task: "control-name", input: inputFor(STORE, root, "a", 1), attempt: 2, output: { name: "Sale: shop deals", reason: "keeps the visible text" } },
    ],
  });
  assert.deepEqual(statuses(result.outcomes), ["link-name-1:rejected", "link-name-1:accepted"]);
  assert.deepEqual(provider.contexts.map((c) => c.feedback), [null, "new-violation: label-content-name-mismatch"]);
  assert.equal(runner.audits(), 2);
  const [rejected, accepted] = result.outcomes;
  assert.ok(rejected!.status === "rejected" && accepted!.status === "accepted");
  if (rejected!.status !== "rejected" || accepted!.status !== "accepted") return;
  assert.deepEqual(rejected!.newFindings.map((n) => n.ruleId), ["label-content-name-mismatch"]);
  assert.deepEqual([rejected!.candidate.plan.llm?.attempt, accepted!.candidate.plan.llm?.attempt], [1, 2]);
  assert.equal(accepted!.verified, "verified-present-needs-review");
});

test("[LLM-02] the adversarial fixture: two invalid proposals end as gate-rejected: llm-invalid and the loop continues with the next strategy", async (t) => {
  const page = readFileSync(join(import.meta.dirname, "..", "fixtures", "sites", "adversarial", "index.html"), "utf8");
  const files: Record<string, string> = { "images/a.svg": SVG, "images/b.svg": SVG, "images/c.svg": SVG, "images/d.svg": SVG };
  const adversarial = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "llm", "adversarial.json"), "utf8")) as { responses: Scripted[] };
  const imgs = [0, 1, 2, 3].map((i) => makeNode({ tag: "img", selector: `img.i${i}`, attrs: { src: `images/${"abcd"[i]}.svg` }, domTagIndex: i, domTagCount: 4 }));
  const links = [makeNode({ tag: "a", selector: "a.d", attrs: { href: "/d", class: "d" }, domTagIndex: 0, domTagCount: 2 }), makeNode({ tag: "a", selector: "a.e", attrs: { href: "/e", class: "e" }, domTagIndex: 1, domTagCount: 2 })];
  const fallback: Strategy = { name: "alt-advice", kind: "suggest-only", suggest: () => "Write the alt text by hand" };
  const { result, runner, fake } = await runLoop(t, {
    page,
    files,
    baseline: scriptedSnapshot({ violations: [imageAlt(imgs), linkName([links[1]!])] }),
    cases: [],
    responses: () => adversarial.responses,
    catalog: { "image-alt": [altTextLlm, fallback], "link-name": [ariaLabelLlm("link"), fallback] },
  });
  assert.equal(runner.audits(), 0, "no invalid proposal is ever audited");
  assert.equal(fake.calls().length, 10);
  assert.deepEqual(statuses(result.outcomes), [
    "image-alt-1:gate-rejected:alt-has-markup",
    "image-alt-1:gate-rejected:llm-invalid",
    "image-alt-1:suggest-only:catalog",
    "image-alt-2:gate-rejected:alt-too-long",
    "image-alt-2:gate-rejected:llm-invalid",
    "image-alt-2:suggest-only:catalog",
    "image-alt-3:gate-rejected:alt-equals-adjacent-text",
    "image-alt-3:gate-rejected:llm-invalid",
    "image-alt-3:suggest-only:catalog",
    "image-alt-4:gate-rejected:decorative-inside-control",
    "image-alt-4:gate-rejected:llm-invalid",
    "image-alt-4:suggest-only:catalog",
    "link-name-1:gate-rejected:name-generic",
    "link-name-1:gate-rejected:llm-invalid",
    "link-name-1:suggest-only:catalog",
  ]);
  // The instruction hidden in the page text did not reach a candidate: its markup answer was refused by the gate.
  const first = result.outcomes[0]!;
  assert.match(JSON.stringify(first.status === "gate-rejected" ? first.proposal : null), /<b>/);
});

test("[FIX-06] an informative proposal adds alt and is flagged needsHumanReview with llm-text; once accepted it is verified-present-needs-review", async (t) => {
  const { result } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [imageAlt([img(0)])] }),
    cases: [{ when: includes('<img src="images/hero.png" alt="Mini store autumn collection banner">'), snapshot: scriptedSnapshot() }],
    responses: (root) => [{ task: "alt-text", input: inputFor(STORE, root, "img", 0), output: { kind: "informative", alt: "Mini store autumn collection banner", reason: "hero banner" } }],
  });
  assert.deepEqual(statuses(result.outcomes), ["image-alt-1:accepted"]);
  const o = result.outcomes[0]!;
  assert.ok(o.status === "accepted");
  if (o.status !== "accepted") return;
  assert.equal(o.verified, "verified-present-needs-review");
  const plan = o.candidate.plan;
  assert.deepEqual([plan.strategy, plan.kind, plan.needsHumanReview, plan.reviewReason], ["alt-text-llm", "llm", true, "llm-text"]);
  assert.deepEqual(plan.llm, { task: "alt-text", requestId: "image-alt-1/alt-text-llm/a1", attempt: 1, proposal: { kind: "informative", alt: "Mini store autumn collection banner", reason: "hero banner" }, gate: "passed" });
});

test("[FIX-06] a decorative proposal becomes suggest-only: decorative-needs-decision and never writes alt=\"\"; decorative inside a link is rejected by the gate", async (t) => {
  const { result, runner } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [imageAlt([img(2)])] }),
    cases: [],
    responses: (root) => [{ task: "alt-text", input: inputFor(STORE, root, "img", 2), output: { kind: "decorative", alt: "", reason: "visual separator" } }],
  });
  assert.deepEqual(statuses(result.outcomes), ["image-alt-1:suggest-only:decorative-needs-decision"]);
  assert.equal(runner.audits(), 0);
  const o = result.outcomes[0]!;
  assert.ok(o.status === "suggest-only");
  if (o.status !== "suggest-only") return;
  assert.deepEqual(o.plan.edits, []);
  assert.match(o.plan.summary, /alt=""/);
  assert.match(o.plan.summary, /visual separator/);
  assert.equal(o.plan.llm?.gate, "passed");

  const linked = '<!doctype html><html lang="en"><head><title>T</title></head><body><a href="/home"><img src="images/hero.png"></a></body></html>';
  const { result: inLink } = await runLoop(t, {
    page: linked,
    baseline: scriptedSnapshot({ violations: [imageAlt([makeNode({ tag: "img", selector: "img", attrs: { src: "images/hero.png" } })])] }),
    cases: [],
    responses: (root) => [
      { task: "alt-text", input: inputFor(linked, root, "img", 0), attempt: 1, output: { kind: "decorative", alt: "", reason: "logo" } },
      { task: "alt-text", input: inputFor(linked, root, "img", 0), attempt: 2, output: { kind: "decorative", alt: "", reason: "logo" } },
    ],
  });
  assert.deepEqual(statuses(inLink.outcomes), ["image-alt-1:gate-rejected:decorative-inside-control", "image-alt-1:gate-rejected:llm-invalid"]);
});

test("[FIX-05] a link-name finding gets an aria-label from the proposal and no deterministic strategy runs", async (t) => {
  const { result, runner } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [linkName([logo()])] }),
    cases: [{ when: includes('<a href="/" class="logo" aria-label="Mini store home">'), snapshot: scriptedSnapshot() }],
    responses: (root) => [{ task: "control-name", input: inputFor(STORE, root, "a", 0), output: { name: "Mini store home", reason: "logo link to the home page" } }],
  });
  assert.deepEqual(statuses(result.outcomes), ["link-name-1:accepted"]);
  assert.equal(runner.audits(), 1);
  const o = result.outcomes[0]!;
  assert.ok(o.status === "accepted" && o.candidate.plan.strategy === "aria-label-llm" && o.verified === "verified-present-needs-review");
});

test("[RF-4] a proposal with \" and & is written escaped and passes the bounds gate", async (t) => {
  const escaped = 'aria-label="Sale: &quot;shop&quot; deals &amp; more"';
  const { result } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [linkName([promo()])] }),
    cases: [{ when: includes(escaped), snapshot: scriptedSnapshot() }],
    responses: (root) => [{ task: "control-name", input: inputFor(STORE, root, "a", 1), output: { name: 'Sale: "shop" deals & more', reason: "quotes" } }],
  });
  assert.deepEqual(statuses(result.outcomes), ["link-name-1:accepted"]);
  const o = result.outcomes[0]!;
  assert.ok(o.status === "accepted");
  if (o.status !== "accepted") return;
  assert.ok(o.candidate.patch.includes(`+<header><a href="/" class="logo"><svg aria-hidden="true"></svg></a><a href="/sale" class="promo" ${escaped}>`));
});

test("[CLI-01] two unavailable attempts end as gate-rejected: llm-unavailable, set llmUnavailable, and later LLM strategies make no call", async (t) => {
  const { result, fake, runner, lines } = await runLoop(t, {
    baseline: scriptedSnapshot({ violations: [linkName([logo(), promo()]), imageAlt([img(0)])] }),
    cases: [],
    responses: (root) => [
      { task: "control-name", input: inputFor(STORE, root, "a", 0), attempt: 1, error: "timeout" },
      { task: "control-name", input: inputFor(STORE, root, "a", 0), attempt: 2, error: "server_error" },
    ],
  });
  assert.deepEqual(statuses(result.outcomes), ["link-name-1:gate-rejected:llm-unavailable", "link-name-2:gate-rejected:llm-unavailable", "image-alt-1:gate-rejected:llm-unavailable"]);
  assert.equal(result.llmUnavailable, true);
  assert.equal(fake.calls().length, 2, "the circuit breaker stops every later call");
  assert.equal(result.llmCalls, 2);
  assert.equal(runner.audits(), 0);
  assert.deepEqual(lines.filter((l) => l["event"] === "call").map((l) => [l["attempt"], l["gate"], l["reason"]]), [[1, "unavailable", "timeout"], [2, "unavailable", "server_error"]]);
});
