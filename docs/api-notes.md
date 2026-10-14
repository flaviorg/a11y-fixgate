# API notes (Step 0)

Verified on 2026-10-14 inside this project with the pinned versions, Node 24.21.0 and npm 11.19.0.
A throwaway probe imported every API below with types, `tsc --noEmit` (TypeScript 7.0.2) exited 0, and the probe ran green.
The same table was first confirmed on 2026-10-12 in a scratch install; nothing differs.

## axe-core 4.14.0

- `import axe from "axe-core"` typechecks under TS 7 with `moduleResolution: "bundler"`, so the `createRequire` fallback is not needed.
- At run time: `axe.version === "4.14.0"` and `axe.source.length === 1477209`.
- `axe.getRules(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"])` returns 70 rules. Four carry the `experimental` tag: `css-orientation-lock`, `p-as-heading`, `table-fake-caption`, `td-has-header`. The selected set is therefore 66 rules.
- `NodeResult.target` is `CrossTreeSelector[]`; a shadow node is `[["#host","button"]]`.

## parse5 8.0.1

- `parse(html, { sourceCodeLocationInfo: true })`. `import type { DefaultTreeAdapterTypes } from "parse5"` gives `DefaultTreeAdapterTypes.Element` (type-only use is allowed).
- `sourceCodeLocation.startTag`, `endTag` and `attrs` are optional in the types.
- `attrs[name]` covers the whole `name=value` text, quotes included (`SRC=a.png`, `Alt='x'`). Attribute keys and `element.attrs[].name` are lower-cased.
- Offsets refer to the original text: `\r` counts, and a BOM is offset 0 (the element after a BOM starts at line 1, column 2). Offsets are UTF-16 code units.

## diff 9.0.0

- Ships its own types; there is no `@types/diff`.
- `createTwoFilesPatch("a/x.html", "b/x.html", old, new, undefined, undefined, { context: 3 })` starts with a line of `=` characters, then `--- a/x.html` and `+++ b/x.html`.
- `applyPatch(source, patch, { fuzzFactor: 0 })` returns the patched text, or `false` on mismatch. `parsePatch(patch)[0].oldFileName === "a/x.html"`.

## playwright-core 1.64.0

- `chromium.executablePath()` returns a path under `~/Library/Caches/ms-playwright/chromium-1248/...` even though that revision is not installed here (`existsSync` is false). Check existence before use.
- `chromium.launch({ executablePath })` works with the Puppeteer headless shell passed through `A11Y_BROWSER_PATH`.
- `browser.newContext({ viewport, reducedMotion, colorScheme, serviceWorkers: "block" })` is accepted.
- `page.locator("body").ariaSnapshot()` of `<button>Go</button>` is `- button "Go"`.
- The CLI binary is `playwright-core` (`npm run browser:install`).

## zod 4.6.5

- `import * as z from "zod"`.
- `z.url().safeParse("javascript:alert(1)").success === true`, so the protocol refinement of spec 5.2 (`httpsOrLoopback`) is required.

## typescript 7.0.2 and @types/node 26.6.4

- TS is used only as `tsc --noEmit`; no compiler API is imported.

## Node 24.21.0

- Type stripping, `node:test`, `fs.cpSync({ recursive, filter })`, `import.meta.dirname` and `import.meta.main` are available.

## Chunk 2 findings (2026-10-14, local headless shell 155.0.8059.39)

- **Accepted-attribute facts (AUD-02).** `axe._audit` exists only after `axe.source` runs. In Node it runs in a
  `node:vm` context whose global has `setTimeout`, `clearTimeout`, `document: {}` and a `getComputedStyle`
  function (axe registers `window.axe` only when `window.getComputedStyle` is a function). After that,
  `axe._audit.rules[i].any` lists check ids as strings, and the configured checks as objects:
  `{ id: "non-empty-title", options: { attribute: "title" } }` for `button-name`, `link-name`, `image-alt` and
  `label`, plus `{ id: "non-empty-placeholder", options: { attribute: "placeholder" } }` for `label` only.
  `tests/unit/axe-config.unit.test.ts` uses this approach (a) of the plan.
- **CSP.** `page.evaluate(axe.source)` runs on a page whose meta CSP is `default-src 'none'` and axe returns results.
- **Isolation.** `context.route("**/*")` sees the remote stylesheet and the image on another loopback port;
  `route.abort("blockedbyclient")` stops both before any byte reaches the other server.
  `context.routeWebSocket(predicate, handler)` receives the WebSocket before it connects; calling `ws.close()`
  without `connectToServer()` means the other server records no upgrade. The predicate receives a `URL`.
- **Keyboard walk.** In the headless shell, Tab from the last focusable element moves focus back to the document
  (`document.activeElement === document.body`), so a page without a trap stops with `body`.
  A `keydown` handler that calls `preventDefault()` for Tab keeps focus on the element, as expected.
- **`node:zlib.crc32`** exists in Node 24.21 and is typed by `@types/node` 26.6.4; the PNG generator uses it.
- **`Array.prototype.findLast`** is not in the default `lib` for `target: ES2022`, so `src` and `scripts` avoid it.

## Chunk 3 findings (2026-10-14)

- **parse5 and a BOM.** Passed to `parse()` as is, a leading U+FEFF is a character token: the document goes
  into quirks mode and `<html>`, `<head>` and `<body>` become implicit (no `sourceCodeLocation`) even when the
  file writes them. A browser strips the BOM while decoding. `buildHtmlIndex` therefore parses the text
  without the BOM and adds 1 to every offset and to every column on line 1, so offsets still refer to the
  original text (`tests/unit/source-map.unit.test.ts`, `[RF-3]`).
- **parse5 implicit elements.** In a fragment-like file (`<p>x</p>`) `html`, `head` and `body` have
  `sourceCodeLocation: null`; with explicit tags they carry `startTag` and `endTag`.
- **jsdiff hunk shape.** For a change on the middle of three identical `<img>` lines, `createTwoFilesPatch`
  emits `+` the new line before the first unchanged `<img>` and `-` a later identical line (the insert plus
  delete case of spec Appendix A). The bounds gate checks texts, not hunks, so it accepts that patch.
- **jsdiff `applyPatch` with two files.** It throws `applyPatch only works with a single input.`;
  `strictApply` catches it and returns `null`. A header argument of `""` writes no tab after the file name,
  and `parsePatch` gives `oldHeader: ""`.
- **jsdiff and CRLF.** Lines keep their `\r`; a patch made from CRLF text strict-applies and preserves CRLF
  outside the edited range. A diff of identical texts is the two header lines with no hunk.

## Chunk 4 findings (2026-10-14, local headless shell 155.0.8059.39)

- **`page.screenshot()` changes the DOM by default.** Its default `caret: "hide"` sets an inline caret colour on
  every `<input>` and, when it restores it, leaves an empty `style=""` attribute behind. Every node described
  after the screenshot then has an extra `style` attribute, its signature no longer matches the source, and
  the keyboard-trap on `#qty` became unmapped at baseline only (a different fingerprint), so every candidate
  was rejected with `new-keyboard-finding`. The runner now passes `caret: "initial"`; nothing is focused when
  the screenshot is taken, so there is no caret to hide. `audit-fixture.e2e` `[AUD-04]` asserts that the
  node attributes are the same with and without a screenshot.
- **axe `label` matches `label[for]` by attribute value.** After `label-associate` gives the signup input
  `id="email"`, the injected `#email` input is no longer a `label` violation either, because a
  `<label for="email">` now exists, even though `for` resolves to the first element with that id. The audit
  reports `duplicate-id-aria` (incomplete) instead. The rejection still happens (`new-incomplete`), but the
  injected input cannot be used to show selector drift in that tree. `verify-loop.e2e` `[VER-02]` uses an
  edit that keeps the signup input unlabeled and gives it an id.

## Chunk 5 findings (2026-10-14, local headless shell 155.0.8059.39)

- **axe 4.14.0 and the promo link, in a real browser.** `aria-label="Shop deals"` on
  `<a href="/sale" class="promo"><span aria-hidden="true">Sale</span></a>` removes `link-name` and adds
  `label-content-name-mismatch` (a `wcag21a` violation), so the acceptance gate rejects it with
  `new-violation`. `aria-label="Sale: shop deals"` passes. The aria snapshot of `a[2]` goes from `- link:` (with a
  `- /url: /sale` child) to `- 'link "Sale: shop deals"':` (Playwright quotes the YAML key because it contains
  `: `). Asserted by `verify-loop.e2e` and recorded.
- **Logger `child({ component })`.** Until this chunk, a child logger kept the parent's component, because
  `component` is a reserved field. `child()` now switches the component, so the loop logs as `loop` and the
  strategy runner and the client log as `llm` (spec 5.12).
- **`LlmCallContext` carries `feedback`.** The spec's `{ requestId, signal, attempt }` has no way to give
  attempt 2 its feedback, which goes into the prompt (`buildUser(input, feedback)`), never into the key.
- **`LlmResult` output is `unknown`.** A provider resolves `{ kind: "proposal", output: unknown }`: every
  output is untrusted until `altGate` or `nameGate` parses it. The fake's scripted `invalid_json` resolves as
  a raw string, which the schema check turns into `schema-invalid`.
- **`AbortSignal.any` and `AbortSignal.timeout` (globals)** are available in Node 24.21 and combine the
  caller's signal with the per-request timeout in the OpenAI-compatible client. A timeout surfaces as a
  `TimeoutError` (kind `timeout`); any other thrown error is a network failure (kind `network`).
- **The prompt delimiter cannot be closed by page text.** The page fields go into the user message as JSON
  with every `<` written as `\u003c` (still valid JSON), so a page that contains `</untrusted-content>` cannot
  end the block.

## Chunk 6 findings (2026-10-14, local headless shell 155.0.8059.39)

- **`git apply` without a repository.** `git apply --check fixes.patch` and `git apply fixes.patch` work from
  a plain temporary directory that is not a Git repository, with `GIT_CEILING_DIRECTORIES` set to its parent.
  `write.e2e` relies on that (P-17), so the only `git init` stays in the project folder. A changed context line
  (for example `<html class='x'>`) makes the check fail, which the test also asserts.
- **`createTwoFilesPatch` output.** Its text starts with a line of `=` characters, then `--- a/<name>` and
  `+++ b/<name>`. The report drops the `=` line, and `parsePatch` of the concatenation of several files returns
  one entry per file in order (`bounded-patch.unit` splits the text on `^=+\n--- a/` to apply each one).
- **Redaction and escaping order.** `redactText` replaces a key with `<redacted:sk-or-v1->`, which contains `<`
  and `>`. Redacting an already escaped page leaves a stray tag in it, so `escapeHtml` redacts first and then
  escapes: the marker reaches the page as `&lt;redacted:sk-or-v1-&gt;`. `report-html.unit` parses the page and
  asserts that no element is called `redacted`.
- **`aria-label` on a `<pre>`.** A `<pre>` has no role, and axe treats `aria-label` on an element with no role as
  prohibited (`aria-prohibited-attr`, needs review). Giving every scrollable `<pre>` `role="group"`,
  `tabindex="0"` and an `aria-label` passes `scrollable-region-focusable` and leaves the report with no
  needs-review item either (`report-self-audit.e2e`, which also proves the audit has teeth by stripping the
  `tabindex` and `alt` attributes).
- **`parseArgs` errors.** `util.parseArgs` throws a `TypeError` whose message quotes the flag
  (`Unknown option '--frobnicate'`), and `code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"` for a flag without a
  value. `parseCli` turns both into `USAGE` naming the flag. A boolean `--no-fix` and `--no-sarif` are plain
  boolean options with those names.
- **A symlinked page between the audit and the write.** The scratch copy skips symlinks, and
  `existsInsideRoot` is false for one, so the page file of the second audit would be null and every finding
  unmapped: the write would end as `COMBINED_MISMATCH` instead of `UNSAFE_PATH`. `writeVerifiedFixes` therefore
  checks every target (`readInsideRoot`: no symlink, inside the root, unchanged since the audit) before the
  subset audit and again, through `writeInsideRoot`, at the moment of writing.
- **Closed loopback port.** With the no-network guard, `fetch` to `http://127.0.0.1:9/` is delegated to the real
  `fetch` (loopback) and fails at once with a network error, with no backoff in the client. `cli.e2e` `[CLI-04]`
  uses it to send a real key in a request header that never connects (exit 5, key absent everywhere).

## Chunk 7 findings (2026-10-14, local headless shell 155.0.8059.39)

- **`@mermaid-js/mermaid-cli` offline.** The package was already in the local npx cache, so `npm_config_offline=true npx -y @mermaid-js/mermaid-cli -p pptr.json -i <file.mmd> -o <file.svg>` renders without
  a download. `pptr.json` is `{ "executablePath": "<headless shell>", "args": ["--no-sandbox"] }`, so mmdc uses the installed headless shell and does not fetch its own Chromium. The three diagrams of
  `README.md` and `docs/architecture.md` rendered without an error.
- **WebAIM Million, re-fetched 2026-10-14.** The 2026 report still reads 95.9% of home pages with detected WCAG 2 failures and 56.1 errors per page; the six failure types and their percentages are unchanged
  (`docs/standards-and-law.md`).
- **`locator.screenshot()`** of a block taller than the viewport (the promo-link block of the report, about 1,700 CSS px at a 980 px viewport) captures the whole block without a clip option; at a device scale
  factor of 2 the PNG is 1,896 by 3,356 pixels.
- **GIF assembly.** `ffmpeg -framerate 6 -i frame-%04d.png -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse"` turns 80 frames of 1,516 by 777 pixels into a 140 KB GIF.
- **A `-- --browser` run takes about 3 s here** (15 audits with the headless shell), against about 0.1 s for the recorded replay of the same 15 audits; spec 10.2's 24.9 s was illustrative.
- **`git`** inside agent shells fails because of a shell wrapper function; `npm run setup:hooks` runs `git` from `sh` and works, and `command git` is used from the shell.
