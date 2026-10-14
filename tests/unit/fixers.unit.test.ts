// Deterministic fixers and suggest-only catalog entries (spec 5.5; FIX-02, FIX-03, FIX-07, FIX-09; RF-3, RF-4). Pure.
import test from "node:test";
import assert from "node:assert/strict";
import type { FixPlan } from "../../src/contracts/fix.ts";
import { checkCandidate, applyEdits, toUnifiedDiff } from "../../src/domain/fix/bounded-patch.ts";
import { strategiesFor } from "../../src/domain/fix/catalog.ts";
import { CATALOG } from "../../src/domain/fix/catalog.ts";
import { contrastInline } from "../../src/domain/fix/fixers/contrast-inline.ts";
import { labelAssociate } from "../../src/domain/fix/fixers/label-associate.ts";
import { labelFreshId } from "../../src/domain/fix/fixers/label-fresh-id.ts";
import { titleFromH1 } from "../../src/domain/fix/fixers/document-title.ts";
import { htmlLang } from "../../src/domain/fix/fixers/html-lang.ts";
import { attributeEdit } from "../../src/domain/fix/fixers/set-attribute.ts";
import { escapeAttr } from "../../src/domain/fix/plan.ts";
import type { FixContext, StrategyResult } from "../../src/domain/fix/types.ts";
import { buildHtmlIndex } from "../../src/domain/map/html-index.ts";
import { applyChecked, fixContextFor } from "../helpers/fix-context.ts";
import { readFixture, readHtmlFixture } from "../helpers/fixtures.ts";

function planOf(r: StrategyResult): FixPlan {
  assert.equal(r.type, "plan", `expected a plan, got ${JSON.stringify(r)}`);
  return (r as { plan: FixPlan }).plan;
}

/** The text that differs between a and b (common prefix and suffix removed). */
function changed(a: string, b: string): { removed: string; added: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s) };
}

const CONTRAST_DATA = { fgColor: "#9a9a9a", bgColor: "#ffffff", contrastRatio: 2.81, expectedContrastRatio: "4.5:1" };

test("[FIX-07] contrast-inline replaces only the color declaration inside style, flags design-review, and is suggest-only when the color is not inline", () => {
  const html = readHtmlFixture("contrast-inline.html");
  const ctx = fixContextFor(html, { ruleId: "color-contrast", tag: "p", ordinal: 0, data: CONTRAST_DATA });
  const plan = planOf(contrastInline.run(ctx));
  assert.deepEqual([plan.strategy, plan.kind, plan.needsHumanReview, plan.reviewReason], ["contrast-inline", "deterministic", true, "design-review"]);
  assert.equal(plan.summary, "color:#9a9a9a -> #767676 (2.81:1 -> 4.54:1 on #ffffff)");
  const patched = applyChecked(ctx, plan);
  assert.match(patched, /style="font-weight: bold; color: #767676; background-color: #9a9a9a"/);
  assert.deepEqual(changed(html, patched), { removed: "9A9A9A", added: "767676" });

  const named = fixContextFor(html, { ruleId: "color-contrast", tag: "p", ordinal: 1, data: { ...CONTRAST_DATA, fgColor: "#a9a9a9" } });
  const namedPatched = applyChecked(named, planOf(contrastInline.run(named)));
  assert.match(namedPatched, /style='color:#[0-9a-f]{6}'/);

  const sheet = fixContextFor(html, { ruleId: "color-contrast", tag: "p", ordinal: 2, data: CONTRAST_DATA });
  const r = contrastInline.run(sheet);
  assert.equal(r.type, "suggest");
  if (r.type !== "suggest") return;
  assert.deepEqual([r.reason, r.plan.kind, r.plan.edits], ["catalog", "suggest-only", []]);
  assert.match(r.plan.summary, /#767676/);
  // A different inline color than the one axe reported is not touched either.
  const other = fixContextFor(html, { ruleId: "color-contrast", tag: "p", ordinal: 0, data: { ...CONTRAST_DATA, fgColor: "#888888" } });
  assert.equal(contrastInline.run(other).type, "suggest");
});

test("[FIX-02] html-lang with an explicit --lang adds lang=\"en\" to the <html> start tag and touches nothing else", () => {
  const html = readHtmlFixture("lang-plain.html");
  const ctx = fixContextFor(html, { ruleId: "html-has-lang", tag: "html", lang: "en" });
  const plan = planOf(htmlLang.run(ctx));
  assert.deepEqual([plan.strategy, plan.summary, plan.needsHumanReview, plan.reviewReason, plan.edits.length], ["html-lang", 'lang="en"', false, null, 1]);
  const patched = applyChecked(ctx, plan);
  assert.deepEqual(changed(html, patched), { removed: "", added: ' lang="en"' });
  assert.match(patched, /^<!doctype html>\n<html lang="en">\n<head>/);
});

test("[FIX-02] html-lang infers from content-language, then og:locale (pt_BR to pt-BR), flagged inferred-lang", () => {
  const fromHeader = fixContextFor(readHtmlFixture("lang-content-language.html"), { ruleId: "html-has-lang", tag: "html" });
  const p1 = planOf(htmlLang.run(fromHeader));
  assert.deepEqual([p1.summary, p1.needsHumanReview, p1.reviewReason], ['lang="fr-CA"', true, "inferred-lang"]);
  applyChecked(fromHeader, p1);
  const fromOg = fixContextFor(readHtmlFixture("lang-og-locale.html"), { ruleId: "html-has-lang", tag: "html" });
  const p2 = planOf(htmlLang.run(fromOg));
  assert.deepEqual([p2.summary, p2.needsHumanReview, p2.reviewReason], ['lang="pt-BR"', true, "inferred-lang"]);
  // An explicit --lang wins over every signal and is not flagged.
  const explicit = fixContextFor(readHtmlFixture("lang-og-locale.html"), { ruleId: "html-has-lang", tag: "html", lang: "en" });
  const p3 = planOf(htmlLang.run(explicit));
  assert.deepEqual([p3.summary, p3.needsHumanReview], ['lang="en"', false]);
});

test("[FIX-02] html-lang without --lang and without a signal is suggest-only: lang-unknown", () => {
  const ctx = fixContextFor(readHtmlFixture("lang-plain.html"), { ruleId: "html-has-lang", tag: "html" });
  const r = htmlLang.run(ctx);
  assert.equal(r.type, "suggest");
  if (r.type !== "suggest") return;
  assert.deepEqual([r.reason, r.plan.edits], ["lang-unknown", []]);
  assert.match(r.plan.summary, /--lang/);
});

test("[FIX-02] html-lang sets an existing empty lang attribute within its own range", () => {
  const html = readHtmlFixture("lang-empty.html");
  const ctx = fixContextFor(html, { ruleId: "html-has-lang", tag: "html", lang: "en" });
  const plan = planOf(htmlLang.run(ctx));
  assert.deepEqual(plan.edits[0]!.range, { file: "index.html", ...ctx.location.attrs["lang"]! });
  const patched = applyChecked(ctx, plan);
  assert.match(patched, /<html lang="en" class="no-js">/);
});

test("[FIX-03] title-from-h1 inserts <title>Orbit Outfitters</title> right after <head>, fills an empty <title>, and is suggest-only without an h1 or an explicit head", () => {
  const html = readHtmlFixture("title-h1.html");
  const ctx = fixContextFor(html, { ruleId: "document-title", tag: "html" });
  const plan = planOf(titleFromH1.run(ctx));
  assert.deepEqual([plan.strategy, plan.summary, plan.edits[0]!.kind, plan.needsHumanReview], ["title-from-h1", "<title>Orbit Outfitters</title>", "element-insert", false]);
  const patched = applyChecked(ctx, plan);
  assert.match(patched, /<head><title>Orbit Outfitters<\/title>\n<meta charset="utf-8">/);

  const empty = readHtmlFixture("title-empty.html");
  const ctx2 = fixContextFor(empty, { ruleId: "document-title", tag: "html" });
  const filled = applyChecked(ctx2, planOf(titleFromH1.run(ctx2)));
  assert.deepEqual(changed(empty, filled), { removed: " ", added: "Orbit Outfitters" });

  for (const name of ["title-no-h1.html", "title-implicit-head.html"]) {
    const r = titleFromH1.run(fixContextFor(readHtmlFixture(name), { ruleId: "document-title", tag: "html" }));
    assert.equal(r.type, "suggest", name);
    if (r.type === "suggest") assert.deepEqual([r.reason, r.plan.edits], ["catalog", []], name);
  }
});

test("[FIX-09] target-size and the three keyboard checks are suggest-only with the spec 5.5 messages and no edits", () => {
  const html = '<!doctype html><html lang="en"><head><title>t</title></head><body><button class="step">-</button><input id="qty"><a class="skip" href="#m">Skip</a><div class="btn" onclick="x()">Add</div></body></html>';
  const run = (ruleId: string, tag: string, data: Record<string, unknown>, selector: string): string => {
    const strategies = strategiesFor(ruleId);
    assert.equal(strategies.length, 1, ruleId);
    const s = strategies[0]!;
    assert.equal(s.kind, "suggest-only", ruleId);
    const ctx: FixContext = fixContextFor(html, { ruleId, tag, data });
    ctx.finding.node.selector = selector;
    return s.kind === "suggest-only" ? s.suggest(ctx) : "";
  };
  const size = run("target-size", "button", { minSize: 24, width: 16, height: 16 }, ".step");
  assert.match(size, /16 by 16 px/);
  assert.match(size, /24 by 24 px/);
  assert.match(size, /min-width: 24px; min-height: 24px/);
  assert.match(run("target-size", "button", { minSize: 24, width: 16, height: 16 }, JSON.stringify([".step-down"])), /^Target \.step-down is 16 by 16 px/);
  assert.equal(run("keyboard-trap", "input", { repeats: 3 }, "#qty"), "Focus stayed on #qty for 3 Tabs; keydown handlers that cancel Tab must let it through or provide an exit (Esc)");
  assert.equal(
    run("unreachable-control", "div", { reason: "onclick" }, "div.btn"),
    'Use <button> instead of <div onclick>; or add tabindex="0", role="button" and a keydown handler for Enter and Space',
  );
  assert.equal(
    run("focus-obscured", "a", { coveredPoints: 5, coveredBy: "header" }, "a.skip"),
    "Focused a.skip is fully (5 of 5 points) covered by header; add scroll-margin-top or make the header non-overlapping",
  );
  assert.match(run("focus-obscured", "a", { coveredPoints: 2, coveredBy: "header" }, "a.skip"), /partly \(2 of 5\)/);
});

test('[RF-3] attribute insertion goes before "/>" on a self-closing input and keeps CRLF elsewhere; replacing a single-quoted or unquoted value stays inside the start tag', () => {
  const html = '<!doctype html>\r\n<html>\r\n<body>\r\n<INPUT TYPE=email Name=\'mail\' />\r\n<input type=text\r\n  value=x>\r\n</body>\r\n</html>\r\n';
  const index = buildHtmlIndex({ "index.html": html });
  const file = index.files["index.html"]!;
  const [first, second] = file.byTag["input"]!.map((i) => file.elements[i]!.location);
  const check = (edit: ReturnType<typeof attributeEdit>): string => {
    const patched = applyEdits(html, [edit]);
    assert.deepEqual(checkCandidate({ file: "index.html", original: html, patched, patch: toUnifiedDiff("index.html", html, patched), edits: [edit] }), { ok: true });
    assert.equal(patched.split("\r\n").length, html.split("\r\n").length, "every CRLF kept");
    return patched;
  };
  assert.match(check(attributeEdit(first!, "aria-label", "Email", html)), /<INPUT TYPE=email Name='mail' aria-label="Email" \/>\r\n/);
  assert.match(check(attributeEdit(first!, "name", "e-mail", html)), /<INPUT TYPE=email name="e-mail" \/>/);
  assert.match(check(attributeEdit(first!, "type", "text", html)), /<INPUT type="text" Name='mail' \/>/);
  assert.match(check(attributeEdit(second!, "value", "y", html)), /<input type=text\r\n {2}value="y">/);
  assert.match(check(attributeEdit(second!, "id", "f", html)), /<input type=text\r\n {2}value=x id="f">/);
  // An unquoted value ending in "/" belongs to the value, so the insertion goes before ">".
  const slash = "<html><body><a href=/x/>x</a></body></html>";
  const a = buildHtmlIndex({ "index.html": slash }).files["index.html"]!;
  const loc = a.elements[a.byTag["a"]![0]!]!.location;
  assert.equal(applyEdits(slash, [attributeEdit(loc, "title", "t", slash)]), '<html><body><a href=/x/ title="t">x</a></body></html>');
});

test("[RF-4] values containing \", & and ' are escaped as &quot; and &amp;, and the edit passes checkCandidate", () => {
  assert.equal(escapeAttr(`Sale: "shop" deals & more <now> it's`), "Sale: &quot;shop&quot; deals &amp; more &lt;now&gt; it's");
  const html = '<!doctype html><html lang="en"><head><title>t</title></head><body><a href="/sale" class="promo"><span aria-hidden="true">Sale</span></a></body></html>';
  const ctx = fixContextFor(html, { ruleId: "link-name", tag: "a" });
  const edit = attributeEdit(ctx.location, "aria-label", `Sale: "shop" deals & more`, html);
  const patched = applyChecked(ctx, { strategy: "aria-label-llm", kind: "llm", edits: [edit], summary: "", needsHumanReview: true, reviewReason: "llm-text", generatedIds: [] });
  assert.match(patched, /<a href="\/sale" class="promo" aria-label="Sale: &quot;shop&quot; deals &amp; more">/);
  const reparsed = buildHtmlIndex({ "index.html": patched }).files["index.html"]!;
  assert.equal(reparsed.elements[reparsed.byTag["a"]![0]!]!.attrs["aria-label"], `Sale: "shop" deals & more`);
});

// Task 22: label strategies and catalog order.

const STOREFRONT = readFixture("index.html");
const STOREFRONT_DOM_IDS = ["email", "main", "qty"];
const emailCtx = (domIds: string[] = STOREFRONT_DOM_IDS) => fixContextFor(STOREFRONT, { ruleId: "label", tag: "input", ordinal: 1, domIds });

test('[FIX-04] on the exact fixture markup with domIds containing "email", label-associate proposes id="email"/for="email" and label-fresh-id proposes email-2', () => {
  const ctx = emailCtx();
  const assoc = planOf(labelAssociate.run(ctx));
  assert.deepEqual([assoc.strategy, assoc.kind, assoc.summary, assoc.generatedIds, assoc.needsHumanReview], ["label-associate", "deterministic", 'id="email" / for="email"', ["email"], false]);
  const patched = applyChecked(ctx, assoc);
  assert.match(patched, /<label for="email">Email<\/label><input type="email" name="email" id="email">/);

  const fresh = planOf(labelFreshId.run(emailCtx()));
  assert.deepEqual([fresh.strategy, fresh.summary, fresh.generatedIds], ["label-fresh-id", 'id="email-2" / for="email-2"', ["email-2"]]);
  assert.match(applyChecked(ctx, fresh), /<label for="email-2">Email<\/label><input type="email" name="email" id="email-2">/);

  // The search input has no adjacent label: both strategies skip, so the catalog moves on to the LLM.
  const search = fixContextFor(STOREFRONT, { ruleId: "label", tag: "input", ordinal: 0, domIds: STOREFRONT_DOM_IDS });
  assert.deepEqual([labelAssociate.run(search).type, labelFreshId.run(search).type], ["skip", "skip"]);
});

test("[FIX-04] label-associate never reads domIds: the same plan with an empty and a full domIds list", () => {
  const plans = [[], STOREFRONT_DOM_IDS, ["email", "email", "field-1"]].map((domIds) => {
    const ctx = emailCtx(domIds);
    const guarded: FixContext = { ...ctx, snapshot: new Proxy(ctx.snapshot, { get: (target, key) => (key === "domIds" ? assert.fail("label-associate read snapshot.domIds") : Reflect.get(target, key)) }) };
    return planOf(labelAssociate.run(guarded));
  });
  assert.deepEqual(plans[1], plans[0]);
  assert.deepEqual(plans[2], plans[0]);
  // A name already used as an id in the file, or reserved in this run, falls back to field-<n>.
  const taken = fixContextFor('<html><body><p id="email"></p><label>Email</label><input name="email"></body></html>', { ruleId: "label", tag: "input" });
  assert.deepEqual(planOf(labelAssociate.run(taken)).generatedIds, ["field-1"]);
  const reserved = fixContextFor("<html><body><label>Email</label><input name=\"email\"></body></html>", { ruleId: "label", tag: "input", reserved: ["email", "field-1"] });
  assert.deepEqual(planOf(labelAssociate.run(reserved)).generatedIds, ["field-2"]);
  // An input that already has an id gets only the for attribute; a label that wraps the input works too.
  const withId = fixContextFor('<html><body><label>Name <input id="n1" name="n"></label></body></html>', { ruleId: "label", tag: "input" });
  const p = planOf(labelAssociate.run(withId));
  assert.deepEqual([p.summary, p.generatedIds, p.edits.length], ['for="n1"', [], 1]);
  applyChecked(withId, p);
});

test('[FIX-04] label-fresh-id also fixes a label for="X" whose X is dangling or duplicated in domIds', () => {
  const dangling = fixContextFor('<html><body><label for="nope">Name</label><input name="full name"></body></html>', { ruleId: "label", tag: "input", domIds: [] });
  assert.equal(labelAssociate.run(dangling).type, "skip");
  const p1 = planOf(labelFreshId.run(dangling));
  assert.deepEqual(p1.generatedIds, ["full-name"]);
  assert.match(applyChecked(dangling, p1), /<label for="full-name">Name<\/label><input name="full name" id="full-name">/);

  const duplicated = fixContextFor('<html><body><label for="dup">Code</label><input id="dup"></body></html>', { ruleId: "label", tag: "input", domIds: ["dup", "dup"] });
  const p2 = planOf(labelFreshId.run(duplicated));
  assert.deepEqual(p2.generatedIds, ["field"]);
  assert.match(applyChecked(duplicated, p2), /<label for="field">Code<\/label><input id="field">/);

  // A for that points to one existing element is somebody else's label: no fix.
  const elsewhere = fixContextFor('<html><body><label for="other">Code</label><input name="c"><input id="other"></body></html>', { ruleId: "label", tag: "input", domIds: ["other"] });
  assert.equal(labelFreshId.run(elsewhere).type, "skip");
});

test("[FIX-01] every catalog entry lists at most 3 strategies, with no deterministic strategy after an LLM one", () => {
  for (const [rule, strategies] of Object.entries(CATALOG)) {
    assert.ok(strategies.length >= 1 && strategies.length <= 3, rule);
    const firstLlm = strategies.findIndex((s) => s.kind === "llm");
    if (firstLlm >= 0) assert.ok(strategies.slice(firstLlm).every((s) => s.kind === "llm"), rule);
  }
  assert.deepEqual(strategiesFor("label").map((s) => s.name), ["label-associate", "label-fresh-id", "aria-label-llm"]);
  const textbox = strategiesFor("label")[2]!;
  assert.ok(textbox.kind === "llm" && textbox.role === "textbox" && textbox.task === "control-name");
  assert.deepEqual(strategiesFor("image-alt").map((s) => [s.name, s.kind]), [["alt-text-llm", "llm"]]);
  assert.deepEqual(strategiesFor("region"), []);
});

test("[FIX-05] button-name and link-name have exactly one strategy, aria-label-llm, and no deterministic strategy", () => {
  for (const [rule, role] of [["button-name", "button"], ["link-name", "link"]] as const) {
    const strategies = strategiesFor(rule);
    assert.equal(strategies.length, 1, rule);
    const s = strategies[0]!;
    assert.ok(s.kind === "llm" && s.name === "aria-label-llm" && s.role === role && s.task === "control-name", rule);
  }
});
