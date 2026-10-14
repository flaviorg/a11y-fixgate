// Writes the three storefront PNGs (solid rectangles) with node:zlib only. Run once:
//   node scripts/make-fixture-images.ts
// The generated files are versioned output under fixtures/storefront/images.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];
type Rect = { x: number; y: number; width: number; height: number; color: Rgb };

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** An 8-bit RGB PNG of the given size: a background color with rectangles painted over it. */
export function makePng(width: number, height: number, background: Rgb, rects: Rect[] = []): Buffer {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let color: Rgb = background;
      for (const rect of rects) if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) color = rect.color; // the last match wins
      const [r, g, b] = color;
      const at = y * rowBytes + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (import.meta.main) {
  const dir = join(import.meta.dirname, "..", "fixtures", "storefront", "images");
  const images: Record<string, Buffer> = {
    "hero.png": makePng(480, 120, [20, 40, 80], [
      { x: 0, y: 84, width: 480, height: 36, color: [40, 90, 60] },
      { x: 300, y: 18, width: 40, height: 40, color: [240, 200, 80] },
    ]),
    "jacket.png": makePng(160, 160, [236, 236, 236], [
      { x: 40, y: 30, width: 80, height: 110, color: [30, 110, 70] },
      { x: 20, y: 40, width: 20, height: 70, color: [30, 110, 70] },
      { x: 120, y: 40, width: 20, height: 70, color: [30, 110, 70] },
      { x: 78, y: 30, width: 4, height: 110, color: [20, 60, 40] },
    ]),
    "divider.png": makePng(640, 8, [210, 210, 210], [{ x: 0, y: 3, width: 640, height: 2, color: [150, 150, 150] }]),
  };
  for (const [name, bytes] of Object.entries(images)) writeFileSync(join(dir, name), bytes);
  process.stderr.write(`wrote ${Object.keys(images).length} images to ${dir}\n`);
}
