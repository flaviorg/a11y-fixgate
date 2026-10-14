# Media

Every file here was captured from a real run on 2026-10-14, never drawn by hand. The machine was an Apple-silicon Mac with Node 24.21.0 and the Puppeteer headless shell
155.0.8059.39 as the Chromium (`A11Y_BROWSER_PATH`). The LLM answers in them are scripted answers from the fake provider; LLM quality is not measured (`docs/eval.md`).

| File | What it is | How it was made |
|---|---|---|
| `hero-promo-link.png` | The promo-link block of the HTML report: attempt 1 `aria-label="Shop deals"` rejected with `label-content-name-mismatch`, attempt 2 `"Sale: shop deals"` accepted, and the screen reader view before and after | `node scripts/capture-media.ts --report reports/demo --stdout reports/demo-browser.txt` serves `reports/demo` from the real browser run and takes `locator("#fix-link-name-2").screenshot()` at a 980 px viewport, device scale factor 2 |
| `demo.gif` | The stdout of `npm run demo -- --browser`, revealed line by line in a terminal-styled page (80 frames at 6 fps, 2 s on each `REJECTED` line, 3 s on the last) | The same script screenshots one frame per line with Playwright into a scratch folder under the OS temp directory (`os.tmpdir()`) and assembles them with the system `ffmpeg` (`palettegen` and `paletteuse`) |

The GIF is rendered from the captured output of the run, not screen-recorded, and it is sped up: the run took **3.3 s** in total (15 browser audits), the GIF plays about 13 s of reading time. Its caption in the
README says so. Frame content is the real stdout, character for character.

`docs/sample-report/` is the `report.html` and `screenshots/` of the same run (`reports/demo` after `npm run demo -- --browser`). Opened from a clone, it needs no server: its two screenshots are relative files.

Re-create the media: `npm run demo -- --browser > reports/demo-browser.txt` (`reports/` is git-ignored), then the `capture-media.ts` command above, then copy `reports/demo/report.html` and `reports/demo/screenshots` to `docs/sample-report/`.
The script needs a browser and `ffmpeg` on `PATH`; it never runs in CI.

## CI badge

The CI badge in the README points at `https://github.com/flaviorg/a11y-fixgate/actions/workflows/ci.yml` and shows the status of the latest run on `main`.
