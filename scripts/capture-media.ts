// node scripts/capture-media.ts --report <dir> --stdout <file>  (plan Task 38, P-18; never run in CI)
//
// Produces the README media from a real run of `npm run demo -- --browser`:
//   docs/media/hero-promo-link.png  the promo-link card of the report, captured from the served report
//   docs/media/demo.gif             the captured stdout, revealed line by line in a terminal-styled page, one frame per
//                                   line (2 s on each REJECTED line), assembled with the system ffmpeg
// Needs a browser (A11Y_BROWSER_PATH or Playwright's) and ffmpeg on PATH. ffmpeg is a build tool, not a dependency.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { noBrowserMessage, resolveBrowser } from "../src/browser/browser-resolve.ts";
import { escapeHtml } from "../src/output/escape.ts";
import { staticServerFactory } from "../src/infra/static-server.ts";
import { writeErr, writeOut } from "../src/infra/write-out.ts";

const PROJECT = join(import.meta.dirname, "..");
const MEDIA = join(PROJECT, "docs", "media");
const FRAMES = join(tmpdir(), "a11y-fixgate-gif-frames");
const FPS = 6;

const { values } = parseArgs({ options: { report: { type: "string" }, stdout: { type: "string" } }, strict: true });
if (!values.report || !values.stdout) {
  writeErr("usage: node scripts/capture-media.ts --report <dir> --stdout <file>");
  process.exit(2);
}
const reportDir = resolve(values.report);
const stdoutText = readFileSync(resolve(values.stdout), "utf8").trimEnd();

const browser = resolveBrowser({ A11Y_BROWSER_PATH: process.env["A11Y_BROWSER_PATH"] });
if (!browser) {
  writeErr(`NO_BROWSER: ${noBrowserMessage()}`);
  process.exit(3);
}
mkdirSync(MEDIA, { recursive: true });

const lineClass = (line: string): string =>
  line.includes("REJECTED") ? "rej" : / accepted /.test(line) ? "acc" : /^(Baseline|Mapping|Fix loop|Combined audit|Accepted|Screen reader|Remaining|Outputs|Finished)/.test(line) ? "hi" : /^a11y-fixgate demo|^Page:/.test(line) ? "dim" : "";

function terminalPage(lines: string[], width: number): string {
  const body = lines.map((l) => `<div class="${lineClass(l)}">${escapeHtml(l) || "&nbsp;"}</div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>demo</title><style>
body{margin:0;background:#101418;color:#d6dde4;font:12px/17px Menlo,Consolas,monospace}
.bar{background:#1c232b;color:#9fb0bf;padding:8px 14px;font-size:12px}
.screen{padding:12px 14px;white-space:pre;width:${width}px}
.rej{color:#ff7b72;font-weight:bold}.acc{color:#7ee787}.hi{color:#79c0ff}.dim{color:#8b98a5}.cmd{color:#e6edf3}
</style></head><body><div class="bar">terminal: npm run demo -- --browser</div><div class="screen">${body}</div></body></html>`;
}

const server = await staticServerFactory.start(reportDir);
const executablePath = browser.executablePath;
const instance = await chromium.launch({ executablePath });
try {
  // (a) the hero image: the promo-link card of the report.
  const reportPage = await (await instance.newContext({ viewport: { width: 980, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await reportPage.goto(new URL("report.html", server.url).href);
  const card = reportPage.locator("#fix-link-name-2");
  if ((await card.count()) !== 1) throw new Error("the report has no #fix-link-name-2 block; the promo link is not link-name-2 in this run");
  await card.screenshot({ path: join(MEDIA, "hero-promo-link.png"), animations: "disabled" });
  writeOut("wrote docs/media/hero-promo-link.png");

  // (b) the terminal GIF.
  const all = ["$ npm run demo -- --browser", "", ...stdoutText.split("\n")];
  const width = Math.min(1800, Math.max(...all.map((l) => l.length)) * 7.3 + 30);
  const termPage = await (await instance.newContext({ viewport: { width: Math.ceil(width + 40), height: Math.ceil(all.length * 17 + 80) }, deviceScaleFactor: 1 })).newPage();
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  let n = 0;
  const snap = async (shown: string[], holdSeconds: number): Promise<void> => {
    await termPage.setContent(terminalPage(shown, width));
    const file = join(FRAMES, `frame-${String(n++).padStart(4, "0")}.png`);
    await termPage.screenshot({ path: file, animations: "disabled" });
    for (let k = 1; k < Math.round(holdSeconds * FPS); k++) copyFileSync(file, join(FRAMES, `frame-${String(n++).padStart(4, "0")}.png`));
  };
  for (let i = 1; i <= all.length; i++) {
    const last = all[i - 1]!;
    await snap(all.slice(0, i), last.includes("REJECTED") ? 2 : i === all.length ? 3 : 1 / FPS);
  }
  const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(FRAMES, "frame-%04d.png"), "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", join(MEDIA, "demo.gif")], { encoding: "utf8" });
  if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.error?.message ?? ff.stderr}`);
  if (!existsSync(join(MEDIA, "demo.gif"))) throw new Error("demo.gif was not written");
  writeOut(`wrote docs/media/demo.gif from ${n} frames at ${FPS} fps`);
} finally {
  await instance.close();
  await server.close();
}
