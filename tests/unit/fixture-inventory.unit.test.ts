// The storefront fixture expresses the inventory of spec 5.15. Pure checks over the source text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { FIXTURE_ROOT, readFixture } from "../helpers/fixtures.ts";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

function elementsOf(root: ParentNode): Element[] {
  const out: Element[] = [];
  const visit = (node: ParentNode): void => {
    for (const child of node.childNodes) {
      if ("tagName" in child) {
        out.push(child);
        visit(child);
        if (child.tagName === "template") visit((child as DefaultTreeAdapterTypes.Template).content);
      }
    }
  };
  visit(root);
  return out;
}

const html = readFixture("index.html");
const elements = elementsOf(parse(html, { sourceCodeLocationInfo: true }));
const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const classOf = (el: Element): string => attr(el, "class") ?? "";

/** The markup newsletter.js appends: the template literal assigned to MARKUP. */
function newsletterMarkup(): string {
  const js = readFixture("newsletter.js");
  const m = /const MARKUP = `([^`]*)`;/.exec(js);
  assert.ok(m, "newsletter.js defines const MARKUP = `...`;");
  return m[1]!;
}
const injected = elementsOf(parseFragment(newsletterMarkup()));

test("[AUD-02] no fixture element carries a title or placeholder attribute", () => {
  for (const el of [...elements, ...injected]) {
    assert.equal(attr(el, "title"), undefined, `${el.tagName} has title`);
    assert.equal(attr(el, "placeholder"), undefined, `${el.tagName} has placeholder`);
  }
  assert.equal(elements.some((el) => el.tagName === "title"), false, "no <title> (row 2)");
  const htmlEl = elements.find((el) => el.tagName === "html")!;
  assert.equal(attr(htmlEl, "lang"), undefined, "no lang (row 1)");
  assert.ok(htmlEl.sourceCodeLocation, "explicit <html> start tag");
  assert.ok(elements.find((el) => el.tagName === "head")!.sourceCodeLocation?.startTag, "explicit <head> start tag");
});

test("[CS-4] the source has 3 input and 3 button elements, and newsletter.js appends exactly one input#email and one button", () => {
  assert.equal(elements.filter((el) => el.tagName === "input").length, 3);
  assert.equal(elements.filter((el) => el.tagName === "button").length, 3);
  assert.equal(elements.filter((el) => el.tagName === "img").length, 4);
  assert.equal(elements.filter((el) => el.tagName === "label").length, 2, "Email and Quantity: the Quantity label keeps #qty out of the label rule, so the rule counts 3 nodes");
  const inputs = injected.filter((el) => el.tagName === "input");
  const buttons = injected.filter((el) => el.tagName === "button");
  assert.equal(inputs.length, 1);
  assert.equal(attr(inputs[0]!, "id"), "email");
  assert.equal(buttons.length, 1);
  assert.equal(injected.filter((el) => el.tagName === "form" && classOf(el) === "newsletter").length, 1);
  assert.match(readFixture("newsletter.js"), /querySelector\("footer"\)/);
  const script = elements.find((el) => el.tagName === "script");
  assert.equal(script && attr(script, "src"), "newsletter.js");
});

test("[CS-4] the two jacket images have identical start tags and the steppers differ only by class", () => {
  const startTag = (el: Element): string => {
    const loc = el.sourceCodeLocation!.startTag!;
    return html.slice(loc.startOffset, loc.endOffset);
  };
  const jackets = elements.filter((el) => el.tagName === "img" && attr(el, "src") === "images/jacket.png");
  assert.equal(jackets.length, 2);
  assert.equal(startTag(jackets[0]!), startTag(jackets[1]!));
  const steppers = elements.filter((el) => el.tagName === "button" && classOf(el).split(" ").includes("step"));
  assert.deepEqual(steppers.map(classOf), ["step step-down", "step step-up"]);
  const others = (el: Element) => el.attrs.filter((a) => a.name !== "class");
  assert.deepEqual(others(steppers[0]!), others(steppers[1]!));
});

test("[CS-4] the document order and the elements of each inventory row are in the source", () => {
  const sig = (el: Element): string => {
    const cls = classOf(el);
    const id = attr(el, "id");
    return `${el.tagName}${id ? `#${id}` : ""}${cls ? `.${cls.split(" ").join(".")}` : ""}`;
  };
  const keep = (el: Element): boolean =>
    ["a", "input", "button", "img", "h1", "label"].includes(el.tagName) || (el.tagName === "div" && classOf(el) === "btn") || (el.tagName === "p" && classOf(el) === "note");
  const describe = (el: Element): string => {
    if (el.tagName === "img") return `img:${attr(el, "src")}`;
    if (el.tagName === "input") return `input[${attr(el, "type") ?? "text"}]${attr(el, "id") ? `#${attr(el, "id")}` : ""}`;
    return sig(el);
  };
  const expected = [
    "a.skip", "a.logo", "a.promo", "input[search]", "button.cart", "img:images/hero.png", "h1",
    "img:images/jacket.png", "div.btn", "img:images/jacket.png", "p.note", "img:images/divider.png",
    "label", "input[email]", "button.step.step-down", "button.step.step-up", "label", "input[text]#qty",
  ];
  assert.deepEqual(elements.filter(keep).map(describe), expected);
  const header = elements.find((el) => el.tagName === "header")!;
  assert.ok(elementsOf(header).some((el) => el.tagName === "h1"), "the h1 is inside the header");
  const note = elements.find((el) => classOf(el) === "note")!;
  assert.equal(attr(note, "style"), "color:#9a9a9a");
  const qty = elements.find((el) => attr(el, "id") === "qty")!;
  assert.match(attr(qty, "onkeydown") ?? "", /event\.key===?'Tab'/);
  assert.ok(attr(elements.find((el) => classOf(el) === "btn")!, "onclick"));
  assert.equal(attr(elements.find((el) => el.tagName === "main")!, "id"), "main");
  assert.equal(attr(elements.find((el) => classOf(el) === "skip")!, "href"), "#main");
});

function pngSize(rel: string): { signature: boolean; width: number; height: number } {
  const bytes = readFileSync(join(FIXTURE_ROOT, ...rel.split("/")));
  const signature = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { signature, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("[CS-4] the three PNGs exist, start with the PNG signature and have the sizes above", () => {
  assert.deepEqual(pngSize("images/hero.png"), { signature: true, width: 480, height: 120 });
  assert.deepEqual(pngSize("images/jacket.png"), { signature: true, width: 160, height: 160 });
  assert.deepEqual(pngSize("images/divider.png"), { signature: true, width: 640, height: 8 });
});
