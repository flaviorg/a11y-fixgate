// Contrast math (spec 5.5 color-contrast, FIX-07). Pure.
import test from "node:test";
import assert from "node:assert/strict";
import { NAMED_COLORS, contrastRatio, nearestCompliant, parseColor, toHsl } from "../../src/domain/color/contrast.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

test("[FIX-07] parseColor reads #rgb, #rrggbb, rgb(), rgba() and the 148 CSS named colors", () => {
  assert.deepEqual(parseColor("#9a9a9a"), { r: 154, g: 154, b: 154 });
  assert.deepEqual(parseColor("#9A9A9A"), { r: 154, g: 154, b: 154 });
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor("rgb(118, 118, 118)"), { r: 118, g: 118, b: 118 });
  assert.deepEqual(parseColor("rgba(0,128,255,0.5)"), { r: 0, g: 128, b: 255 });
  assert.deepEqual(parseColor("rgb(0 128 255)"), { r: 0, g: 128, b: 255 });
  assert.deepEqual(parseColor(" White "), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor("rebeccapurple"), { r: 102, g: 51, b: 153 });
  assert.deepEqual(parseColor("darkgrey"), parseColor("darkgray"));
  assert.equal(Object.keys(NAMED_COLORS).length, 148);
  for (const bad of ["", "transparent", "#12", "#12345", "rgb(1,2)", "notacolor", "var(--x)"]) assert.equal(parseColor(bad), null, bad);
});

test("[FIX-07] #9a9a9a on white is 2.81:1 and #767676 is 4.54:1", () => {
  assert.equal(round2(contrastRatio("#9a9a9a", "#ffffff")), 2.81);
  assert.equal(round2(contrastRatio("#767676", "#ffffff")), 4.54);
  assert.equal(round2(contrastRatio("#ffffff", "#767676")), 4.54);
  assert.equal(contrastRatio("#000", "#fff"), 21);
});

test('[FIX-07] nearestCompliant("#9a9a9a", "#ffffff", 4.5) is { hex: "#767676", ratio: 4.54 } and keeps hue and saturation; a large-text target of 3 stops earlier', () => {
  assert.deepEqual(nearestCompliant("#9a9a9a", "#ffffff", 4.5), { hex: "#767676", ratio: 4.54 });
  const large = nearestCompliant("#9a9a9a", "#ffffff", 3)!;
  assert.ok(large.ratio >= 3 && large.ratio < 4.5);
  assert.ok(parseColor(large.hex)!.r > 0x76, "fewer steps than the 4.5 target");
  // A colored foreground keeps its hue and saturation (up to channel rounding) and gets darker on white.
  const brand = nearestCompliant("#e07a5f", "#ffffff", 4.5)!;
  assert.ok(brand.ratio >= 4.5);
  const [before, after] = [toHsl(parseColor("#e07a5f")!), toHsl(parseColor(brand.hex)!)];
  assert.ok(Math.abs(before.h - after.h) < 2, `hue ${before.h} vs ${after.h}`);
  assert.ok(Math.abs(before.s - after.s) < 0.03, `saturation ${before.s} vs ${after.s}`);
  assert.ok(after.l < before.l);
  // On a dark background the lightness goes up.
  const onDark = nearestCompliant("#555555", "#000000", 4.5)!;
  assert.ok(parseColor(onDark.hex)!.r > 0x55 && onDark.ratio >= 4.5);
  // Unparseable input or an unreachable target gives null.
  assert.equal(nearestCompliant("var(--x)", "#ffffff", 4.5), null);
  assert.equal(nearestCompliant("#9a9a9a", "#ffffff", 22), null);
});
