// Value gates for LLM proposals (spec 6.2 item 5; LLM-02, LLM-03, LLM-04).
import test from "node:test";
import assert from "node:assert/strict";
import type { AltTextInput, ControlNameInput } from "../../src/contracts/llm.ts";
import { altGate, nameGate } from "../../src/domain/fix/gates.ts";

const altInput = (over: Partial<AltTextInput> = {}): AltTextInput => ({ pageTitle: "Orbit Outfitters", src: "images/jacket.png", surroundingText: "Trail jacket $129 Add to cart", insideControl: false, image: null, ...over });
const informative = (alt: string) => ({ kind: "informative", alt, reason: "test" });
const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

test("[LLM-03] the alt gate rejects empty informative alt, more than 125 chars, <, >, ://, a newline, \"jacket.png\" for src images/jacket.png, \"Image of a jacket\", the adjacent text, and decorative inside a control without another name", () => {
  const adjacent = "Trail jacket $129 Add to cart";
  const table: Array<[unknown, Partial<AltTextInput>, string, string]> = [
    [informative(""), {}, adjacent, "alt-empty"],
    [informative("   "), {}, adjacent, "alt-empty"],
    [informative("x".repeat(126)), {}, adjacent, "alt-too-long"],
    [informative("Green <b>jacket</b>"), {}, adjacent, "alt-has-markup"],
    [informative("Jacket > coat"), {}, adjacent, "alt-has-markup"],
    [informative("See https://example.com/jacket"), {}, adjacent, "alt-has-url"],
    [informative("Green jacket\nwith hood"), {}, adjacent, "alt-has-newline"],
    [informative("jacket.png"), {}, adjacent, "alt-is-filename"],
    [informative("Jacket"), { src: "images/jacket.png?v=2" }, adjacent, "alt-is-filename"],
    [informative("trail jacket"), { src: "/img/Trail_Jacket-01.png" }, adjacent, "alt-redundant-prefix-or-not"],
    [informative("Image of a jacket"), {}, adjacent, "alt-redundant-prefix"],
    [informative("photo of the team"), {}, adjacent, "alt-redundant-prefix"],
    [informative("Trail jacket $129 Add to cart"), {}, adjacent, "alt-equals-adjacent-text"],
    [informative("  trail JACKET $129 add to cart "), {}, adjacent, "alt-equals-adjacent-text"],
    [{ kind: "decorative", alt: "", reason: "icon" }, { insideControl: true }, "", "decorative-inside-control"],
  ];
  for (const [raw, over, adj, expected] of table) {
    if (expected === "alt-redundant-prefix-or-not") {
      // "trail jacket" is not the stem "trail jacket 01": the stem comparison is exact after normalizing case, -, _ and spaces.
      assert.equal(reasonOf(altGate(raw, altInput(over), adj)), "ok");
      continue;
    }
    assert.equal(reasonOf(altGate(raw, altInput(over), adj)), expected, JSON.stringify(raw));
  }
  assert.equal(reasonOf(altGate(informative("trail jacket 01"), altInput({ src: "/img/Trail_Jacket-01.png" }), adjacent)), "alt-is-filename");
  assert.equal(reasonOf(altGate(informative("x".repeat(125)), altInput(), adjacent)), "ok", "125 characters is the maximum");
});

test("[LLM-03] the alt gate accepts \"Green waterproof trail jacket with hood\" and accepts decorative outside a control", () => {
  const ok = altGate(informative("Green waterproof trail jacket with hood"), altInput(), "Trail jacket $129 Add to cart");
  assert.deepEqual(ok, { ok: true, output: { kind: "informative", alt: "Green waterproof trail jacket with hood", reason: "test" } });
  const decorative = altGate({ kind: "decorative", alt: "", reason: "visual separator" }, altInput({ src: "images/divider.png" }), "");
  assert.deepEqual(decorative, { ok: true, output: { kind: "decorative", alt: "", reason: "visual separator" } });
  const insideNamedControl = altGate({ kind: "decorative", alt: "", reason: "icon next to text" }, altInput({ insideControl: true }), "Open cart");
  assert.equal(insideNamedControl.ok, true, "decorative inside a control that has other text is allowed");
  const trimmed = altGate(informative("  Green jacket  "), altInput(), "");
  assert.deepEqual(trimmed.ok && trimmed.output.alt, "Green jacket", "the accepted alt is trimmed");
});

const nameInput = (over: Partial<ControlNameInput> = {}): ControlNameInput => ({ role: "link", html: '<a href="/sale" class="promo">', surroundingText: "", href: "/sale", placeholder: null, iconHints: [], pageTitle: "Orbit Outfitters", ...over });
const proposal = (name: string) => ({ name, reason: "test" });

test("[LLM-04] the name gate rejects empty, more than 80 chars, markup, a URL, a name equal to the href, and every generic word (\"Click here\", \" more \")", () => {
  const table: Array<[unknown, Partial<ControlNameInput>, string]> = [
    [proposal(""), {}, "name-empty"],
    [proposal("  "), {}, "name-empty"],
    [proposal("x".repeat(81)), {}, "name-too-long"],
    [proposal("<img src=x onerror=alert(1)>"), {}, "name-has-markup"],
    [proposal("Go to https://shop.example/sale"), {}, "name-has-url"],
    [proposal("/sale"), {}, "name-equals-href"],
    [proposal(" /SALE "), {}, "name-equals-href"],
    ...["Click here", "here", "LINK", "button", "Read more", " more ", "image", "Icon", "submit"].map((g): [unknown, Partial<ControlNameInput>, string] => [proposal(g), {}, "name-generic"]),
  ];
  for (const [raw, over, expected] of table) assert.equal(reasonOf(nameGate(raw, nameInput(over))), expected, JSON.stringify(raw));
  assert.equal(reasonOf(nameGate(proposal("x".repeat(80)), nameInput())), "ok", "80 characters is the maximum");
  assert.equal(reasonOf(nameGate(proposal("/sale"), nameInput({ href: null, role: "button" }))), "ok", "no href, nothing to equal");
});

test("[LLM-04] the name gate accepts \"Sale: shop deals\" and \"Open cart\"", () => {
  assert.deepEqual(nameGate(proposal("Sale: shop deals"), nameInput()), { ok: true, output: { name: "Sale: shop deals", reason: "test" } });
  assert.deepEqual(nameGate(proposal(" Open cart "), nameInput({ role: "button", href: null })), { ok: true, output: { name: "Open cart", reason: "test" } });
  // Quotes, ampersands and apostrophes pass every value gate (RF-4); escaping happens when the attribute is written.
  assert.equal(nameGate(proposal(`Sale: "shop" deals & more's`), nameInput()).ok, true);
});

test("[LLM-02] a value that fails the Zod schema is schema-invalid", () => {
  const bad: unknown[] = ["{ this is not JSON", null, 42, {}, { kind: "informative", alt: "x" }, { kind: "maybe", alt: "x", reason: "r" }, { kind: "informative", alt: "x", reason: "r", extra: 1 }, { kind: "informative", alt: "x".repeat(401), reason: "r" }];
  for (const raw of bad) assert.deepEqual(altGate(raw, altInput(), ""), { ok: false, reason: "schema-invalid" }, JSON.stringify(raw));
  const badNames: unknown[] = ["Open cart", { name: "Open cart" }, { name: 3, reason: "r" }, { name: "x".repeat(201), reason: "r" }, { name: "Open", reason: "r", alt: "x" }];
  for (const raw of badNames) assert.deepEqual(nameGate(raw, nameInput()), { ok: false, reason: "schema-invalid" }, JSON.stringify(raw));
});
