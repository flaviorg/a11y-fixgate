// The HTML report (spec 5.8; OUT-01, OUT-07, RF-1) rendered from the recorded storefront AuditResult.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { AuditResult } from "../../src/contracts/result.ts";
import { escapeHtml, html } from "../../src/output/escape.ts";
import { renderReport } from "../../src/output/report-html.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";
import { emptyResult } from "../helpers/results.ts";

type El = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.ChildNode;

const isEl = (n: Node | DefaultTreeAdapterTypes.Document): n is El => "tagName" in n;
function elements(root: DefaultTreeAdapterTypes.Document | El): El[] {
  const out: El[] = [];
  const walk = (n: DefaultTreeAdapterTypes.Document | El | Node): void => {
    if (isEl(n as Node)) out.push(n as El);
    for (const c of ("childNodes" in n ? n.childNodes : []) as Node[]) walk(c);
    const content = (n as { content?: DefaultTreeAdapterTypes.DocumentFragment }).content;
    if (content) for (const c of content.childNodes) walk(c);
  };
  walk(root);
  return out;
}
const attr = (e: El, name: string): string | undefined => e.attrs.find((a) => a.name === name)?.value;
const textOf = (n: Node | DefaultTreeAdapterTypes.Document): string => {
  if ("value" in n && typeof n.value === "string") return n.value;
  return (("childNodes" in n ? n.childNodes : []) as Node[]).map(textOf).join("");
};

let cached: Promise<AuditResult> | null = null;
const storefront = (): Promise<AuditResult> => (cached ??= runAuditRecorded("storefront"));

test("[OUT-07] escapeHtml escapes the five characters, and html`` escapes every interpolation", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(42), "42");
  assert.equal(html`<p>${"<b>"}</p>`.html, "<p>&lt;b&gt;</p>");
  assert.equal(html`<ul>${["<i>", html`<li>${"a&b"}</li>`]}</ul>`.html, "<ul>&lt;i&gt;<li>a&amp;b</li></ul>");
  assert.equal(html`${null}${undefined}${false}x`.html, "x");
});

test("[OUT-01] the report has every spec 5.8 section, one card per outcome, both statuses and the needs-review count", async () => {
  const result = await storefront();
  const doc = parse(renderReport(result));
  const els = elements(doc);
  const h2 = els.filter((e) => e.tagName === "h2").map((e) => textOf(e).trim());
  assert.deepEqual(h2, ["Summary", "Fixes", "Suggestions", "Needs review (not fixed)", "Unmapped", "Keyboard trace", "Methodology", "Standards note"]);
  assert.equal(els.filter((e) => e.tagName === "h1").length, 1);
  assert.equal(els.find((e) => e.tagName === "html")?.attrs.find((a) => a.name === "lang")?.value, "en");
  for (const landmark of ["header", "nav", "main", "footer"]) assert.ok(els.some((e) => e.tagName === landmark), landmark);
  assert.ok(els.some((e) => e.tagName === "a" && attr(e, "class") === "skip" && attr(e, "href") === "#main"));
  assert.ok(els.some((e) => e.tagName === "details"), "the keyboard trace is collapsed");

  assert.equal(result.outcomes.length, 21);
  const cards = els.filter((e) => e.tagName === "article" && (attr(e, "class") ?? "").split(" ").includes("card"));
  assert.equal(cards.length, result.outcomes.length);
  const text = textOf(doc);
  assert.match(text, /Verified present, needs review/);
  assert.match(text, /\bVerified\b/);
  assert.match(text, /Needs human review:\s*8/);
  assert.match(text, /Needs review, not fixed:\s*1/);
  assert.match(text, /Who is blocked/);
  assert.match(text, /project rating/);
  assert.match(text, /HSL/);
  assert.match(text, /not a conformance audit and not legal advice/);
  // Each finding block has an id fix-<findingId> and none is duplicated.
  const ids = els.map((e) => attr(e, "id")).filter((v): v is string => v !== undefined);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const f of result.findings.filter((x) => result.outcomes.some((o) => ("candidate" in o ? o.candidate.findingId : o.findingId) === x.id && o.status !== "suggest-only" && o.status !== "unmapped"))) {
    assert.ok(ids.includes(`fix-${f.id}`), `fix-${f.id}`);
  }
});

test("[OUT-01] the promo-link card shows the rejected attempt with label-content-name-mismatch and a screen reader diff paired by DOM key", async () => {
  const result = await storefront();
  const promo = result.findings.find((f) => f.node.attrs["class"] === "promo")!;
  const doc = parse(renderReport(result));
  const block = elements(doc).find((e) => attr(e, "id") === `fix-${promo.id}`);
  assert.ok(block, "the promo finding block exists");
  const blockText = textOf(block);
  assert.match(blockText, /REJECTED/);
  assert.match(blockText, /label-content-name-mismatch/);
  assert.match(blockText, /Shop deals/);
  assert.match(blockText, /Sale: shop deals/);
  const view = elements(block).find((e) => e.tagName === "pre" && (attr(e, "aria-label") ?? "").startsWith("Screen reader view"));
  assert.ok(view, "screen reader view present");
  const lines = textOf(view).split("\n");
  assert.ok(lines.some((l) => l.startsWith("- ") && l.includes("link:")), lines.join("|"));
  assert.ok(lines.some((l) => l.startsWith("+ ") && l.includes("Sale: shop deals")), lines.join("|"));
  // The pairing is by DOM key: both sides come from the same <tag>[<index>].
  const key = `${promo.node.tag}[${promo.node.domTagIndex}]`;
  assert.ok(result.baseline.ariaByNode[key] && result.combined!.snapshot.ariaByNode[key]);
  assert.match(attr(view, "aria-label")!, new RegExp(promo.id));
});

test("[OUT-01] the email card shows duplicate-id-aria for the rejected label-associate attempt", async () => {
  const result = await storefront();
  const text = textOf(parse(renderReport(result)));
  assert.match(text, /duplicate-id-aria/);
  assert.match(text, /label-associate/);
  assert.match(text, /label-fresh-id/);
});

test("[OUT-07] a snippet \"<img src=x onerror=alert(1)>\" and an LLM reason \"</pre><script>\" appear only escaped: no <script and no onerror= outside escaped text", async () => {
  const result = structuredClone(await storefront());
  const evilSnippet = "<img src=x onerror=alert(1)>";
  result.findings[0]!.node.htmlSnippet = evilSnippet;
  result.findings[0]!.node.text = evilSnippet;
  for (const f of result.findings) f.message = `${f.message} ${evilSnippet}`;
  let injected = 0;
  for (const o of result.outcomes) {
    const plan = o.status === "accepted" || o.status === "rejected" ? o.candidate.plan : o.status === "suggest-only" ? o.plan : null;
    if (plan?.llm) {
      plan.llm.proposal = { kind: "informative", alt: "</pre><script>alert(2)</script>", name: "</pre><script>", reason: "</pre><script>" };
      injected++;
    }
    if (o.status === "gate-rejected") o.proposal = { kind: "informative", alt: "x", reason: "</pre><script>" };
  }
  assert.ok(injected >= 3);
  const out = renderReport(result);
  assert.equal(out.includes("<script"), false);
  assert.equal(/<img[^>]*onerror/i.test(out), false);
  const els = elements(parse(out));
  assert.equal(els.filter((e) => e.tagName === "script").length, 0);
  assert.equal(els.filter((e) => e.attrs.some((a) => a.name.startsWith("on"))).length, 0);
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(out.includes("&lt;/pre&gt;&lt;script&gt;"));
});

test("[OUT-07] the CSP meta tag is present with no script source", async () => {
  const out = renderReport(await storefront());
  assert.ok(out.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">`));
  assert.doesNotMatch(out, /script-src/);
  assert.equal(/<script\b/i.test(out), false);
  assert.equal(/<link\b[^>]*stylesheet/i.test(out), false, "no external stylesheet");
});

/** A CSP value as directive name -> source list. */
function cspDirectives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

test("[OUT-07] [CS-6] the report head declares an inline icon that the CSP allows, so a browser never asks the server for /favicon.ico", async () => {
  // A full Chromium requests /favicon.ico on its own when the page names no icon; a static server answers 404 and the
  // console shows an error (CI failed on this). A data: icon needs `data:` in img-src, which is checked from the page itself.
  for (const [label, out] of [["findings", renderReport(await storefront())], ["no findings", renderReport(emptyResult())]] as const) {
    const els = elements(parse(out));
    const head = els.find((e) => e.tagName === "head");
    assert.ok(head, `${label}: the page has a head`);
    const icons = els.filter((e) => e.tagName === "link" && (attr(e, "rel") ?? "").toLowerCase().split(/\s+/).includes("icon"));
    assert.equal(icons.length, 1, `${label}: exactly one rel="icon" link`);
    assert.ok(head.childNodes.includes(icons[0]!), `${label}: the icon link is in the head`);
    const href = attr(icons[0]!, "href") ?? "";
    assert.match(href, /^data:/, `${label}: the icon is inline, not a request to the server`);
    assert.equal(out.includes("favicon.ico"), false, `${label}: nothing names /favicon.ico`);
    const meta = els.find((e) => e.tagName === "meta" && attr(e, "http-equiv") === "Content-Security-Policy");
    const directives = cspDirectives(attr(meta!, "content") ?? "");
    const imgSources = directives.get("img-src") ?? directives.get("default-src") ?? [];
    assert.ok(imgSources.includes("data:"), `${label}: img-src (or default-src) allows data:, got ${imgSources.join(" ")}`);
  }
});

test("[OUT-01] every <pre> has tabindex=\"0\" and an aria-label, every <img> has alt, there are no absolute paths, and a key in the input is redacted", async () => {
  const result = structuredClone(await storefront());
  const key = "sk-or-v1-" + "a".repeat(40);
  result.findings[0]!.message = `leaked ${key}`;
  const out = renderReport(result);
  const els = elements(parse(out));
  const pres = els.filter((e) => e.tagName === "pre");
  assert.ok(pres.length >= 10);
  for (const pre of pres) {
    assert.equal(attr(pre, "tabindex"), "0");
    assert.ok((attr(pre, "aria-label") ?? "").length > 3);
  }
  assert.match(out, /overflow-x:\s*auto/);
  for (const img of els.filter((e) => e.tagName === "img")) assert.ok((attr(img, "alt") ?? "").length > 3);
  assert.equal(out.includes(result.config.sourceRoot), false);
  assert.equal(out.includes(result.config.out), false);
  assert.equal(/(?:^|[\s"'(=])\/(?:Users|home|private|tmp|var)\//.test(out), false);
  assert.equal(out.includes(key), false);
  assert.ok(out.includes("&lt;redacted:sk-or-v1-&gt;"));
  assert.equal(els.some((e) => e.tagName.startsWith("redacted")), false, "the redaction marker is escaped text, not a tag");
});

test("[OUT-01] screenshots are referenced relatively only when the snapshot has them, with a meaningful alt", async () => {
  const result = structuredClone(await storefront());
  assert.equal(result.baseline.screenshots.fullPage, "");
  assert.equal(elements(parse(renderReport(result))).filter((e) => e.tagName === "img").length, 0);
  result.baseline.screenshots.fullPage = "screenshots/page.png";
  result.combined!.snapshot.screenshots.fullPage = "screenshots/page.after.png";
  const imgs = elements(parse(renderReport(result))).filter((e) => e.tagName === "img");
  assert.deepEqual(imgs.map((i) => attr(i, "src")), ["screenshots/page.png", "screenshots/page.after.png"]);
  assert.deepEqual(imgs.map((i) => attr(i, "alt")), ["Full page before fixes", "Full page after the combined fixes"]);
});

test("[RF-1] a result with zero findings renders \"No findings\"", () => {
  const doc = parse(renderReport(emptyResult()));
  const text = textOf(doc);
  assert.match(text, /No findings/);
  assert.match(text, /No fixes/);
  assert.equal(elements(doc).filter((e) => e.tagName === "article").length, 0);
  assert.equal(elements(doc).filter((e) => e.tagName === "h1").length, 1);
});
