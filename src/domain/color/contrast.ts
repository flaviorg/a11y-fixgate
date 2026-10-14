// Contrast math (spec 5.5 color-contrast, FIX-07): WCAG relative luminance and the nearest compliant color
// of the same hue and saturation, found by stepping HSL lightness. Pure.

export type Rgb = { r: number; g: number; b: number };
export type Hsl = { h: number; s: number; l: number };

/** The 148 CSS named colors (CSS Color Module Level 4), as 6-digit hex. */
export const NAMED_COLORS: Record<string, string> = Object.fromEntries(
  (
    "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 " +
    "blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 " +
    "chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b " +
    "darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b " +
    "darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a " +
    "darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 " +
    "darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff " +
    "firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff " +
    "gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 " +
    "hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 " +
    "lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff " +
    "lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 " +
    "lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 " +
    "lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 " +
    "mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 " +
    "mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 " +
    "midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 " +
    "oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa " +
    "palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f " +
    "pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f " +
    "royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee " +
    "sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa " +
    "springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 " +
    "violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32"
  )
    .split(" ")
    .map((pair) => pair.split(":") as [string, string]),
);

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`(\d+(?:\.\d+)?%?)`;
const RGB = new RegExp(String.raw`^rgba?\(\s*${NUMBER}\s*[,\s]\s*${NUMBER}\s*[,\s]\s*${NUMBER}\s*(?:[,/]\s*[\d.]+%?\s*)?\)$`, "i");

function channel(token: string): number | null {
  const pct = token.endsWith("%");
  const n = Number(pct ? token.slice(0, -1) : token);
  if (!Number.isFinite(n)) return null;
  const v = pct ? (n / 100) * 255 : n;
  return v > 255 ? null : Math.round(v);
}

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space separated, alpha ignored) and the named colors; else null. */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  const named = Object.hasOwn(NAMED_COLORS, s) ? `#${NAMED_COLORS[s]}` : s;
  const hex = HEX.exec(named);
  if (hex) {
    const d = hex[1]!;
    const full = d.length <= 4 ? [...d.slice(0, 3)].map((c) => c + c).join("") : d.slice(0, 6);
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
  }
  const rgb = RGB.exec(named);
  if (!rgb) return null;
  const [r, g, b] = [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)];
  return r === null || g === null || b === null ? null : { r, g, b };
}

export function toHex(c: Rgb): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance(c: Rgb): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function ratioOf(a: Rgb, b: Rgb): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The WCAG contrast ratio of two colors (1 to 21); NaN when either does not parse. */
export function contrastRatio(a: string, b: string): number {
  const [ca, cb] = [parseColor(a), parseColor(b)];
  return ca && cb ? ratioOf(ca, cb) : Number.NaN;
}

/** h in degrees [0, 360), s and l in [0, 1]. */
export function toHsl(c: Rgb): Hsl {
  const [r, g, b] = [c.r / 255, c.g / 255, c.b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** HSL to sRGB with channels rounded to integers. */
export function fromHsl({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (v: number) => Math.min(255, Math.max(0, Math.round((v + m) * 255)));
  return { r: to255(r), g: to255(g), b: to255(b) };
}

/**
 * Steps the foreground's HSL lightness by 1 percentage point in the direction that increases contrast with
 * the background (darker when the foreground is the darker color) and returns the first step whose ratio
 * meets the target, with the ratio rounded to 2 decimals. Hue and saturation are kept; channels are rounded.
 * Null when a color does not parse or no step within maxSteps (or the lightness range) meets the target.
 */
export function nearestCompliant(fg: string, bg: string, target: number, maxSteps = 100): { hex: string; ratio: number } | null {
  const [f, b] = [parseColor(fg), parseColor(bg)];
  if (!f || !b) return null;
  const hsl = toHsl(f);
  const lf = relativeLuminance(f);
  const lb = relativeLuminance(b);
  const dir = lf < lb || (lf === lb && lb > 0.18) ? -1 : 1;
  for (let step = 1; step <= maxSteps; step++) {
    const l = hsl.l + (dir * step) / 100;
    const clamped = Math.min(1, Math.max(0, l));
    const c = fromHsl({ ...hsl, l: clamped });
    const ratio = ratioOf(c, b);
    if (ratio >= target) return { hex: toHex(c), ratio: Math.round(ratio * 100) / 100 };
    if (clamped !== l) break;
  }
  return null;
}
