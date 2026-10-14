# Audit and keyboard checks

## Context

The tool audits one static page, served from a scratch copy of `--src` by its own `node:http` server, in a real
Chromium. axe-core 4.14.0 is injected with `page.evaluate(axe.source)` (a page Content-Security-Policy cannot block it)
and runs with a tag-type `runOnly` of the six WCAG tags. Three keyboard checks that axe does not do run in the same
browser: unreachable controls (a violation), and traps and obscured focus (heuristics, reported as `incomplete`).
The snapshot is the only thing the rest of the pipeline sees, so it also carries the DOM ids, the aria snapshots and
the screenshots. Recorded snapshots keyed by a hash of the served tree let unit tests and the demo run without a browser.

## Acceptance criteria

- **AUD-01** When the runner audits a page, the system shall inject axe-core from the installed `axe-core` package with `page.evaluate(axe.source)` and run it with a tag-type `runOnly` of `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a` and `wcag22aa`, and the snapshot's `axeVersion` shall equal the installed `axe.version`; otherwise the run fails with `AXE_VERSION_MISMATCH`.
- **AUD-02** The selected rule set, computed as `axe.getRules(tags)` minus the rules tagged `experimental`, shall contain only rules tagged with at least one `wcag*` tag, shall exclude every `best-practice` rule, and shall include `target-size`, `label-content-name-mismatch` and `scrollable-region-focusable`; the test shall assert that `button-name`, `link-name`, `image-alt` and `label` accept a non-empty `title`, and `label` a non-empty `placeholder`.
- **AUD-03** When axe reports a node, the system shall record a `NodeDescriptor` with tag, attributes, collapsed text, `domTagIndex`, `domTagCount`, snippet and rect, keyed by the serialized target; a node whose target has more than one element or contains a nested array (iframe or shadow root) shall be marked `dom-only` and never resolved with `document.querySelector`.
- **AUD-04** When a browser audit completes, the system shall write a full-page screenshot and record the aria snapshot of every flagged node, and the report shall reference only files that exist.
- **AUD-05** The system shall resolve the browser in the order `A11Y_BROWSER_PATH`, then Playwright's chromium if the file exists; if none is found, browser e2e tests shall skip unless `REQUIRE_BROWSER=1` or `CI` is set, in which case they shall fail, and the CLI shall exit 3 with a message naming the two resolution steps (`A11Y_BROWSER_PATH`, `npm run browser:install`) and the installed `playwright-core` version.
- **AUD-06** When the recorded runner receives a target whose recording key (`treeSha256` of the served root plus the sorted watch list) has no recording, it shall fail with `NO_RECORDING` naming the first 12 hex characters of the tree hash and the record command; the key shall change when any served file or the watch list changes; every recording shall validate against the snapshot schema and carry the installed axe version.
- **AUD-07** The snapshot shall keep axe `incomplete` results separately from `violations`, and both shall be fingerprinted.
- **AUD-08** The snapshot shall carry `domIds`, the `id` of every element in the live DOM after load, duplicates kept, and the runner shall allow browser traffic only to the exact origin (scheme, host and port) of the tool's own server: every other HTTP request aborted (other loopback ports included), every WebSocket to another origin closed, service workers blocked.
- **AUD-09** When the audited page carries a Content-Security-Policy that forbids inline scripts, the runner shall still inject and run axe (by evaluation, not by a script tag) and return its results.
- **AUD-10** When a target lists watched DOM node keys, the runner shall capture the aria snapshot of each watched node, located by tag and DOM tag index (never by a baseline selector), whether or not it is flagged, into `ariaByNode` under that key; the report's screen reader view shall pair the before and after snapshots by that key.
- **KBD-01** When the traversal runs, the system shall start from the document with nothing focused, press Tab up to 200 times, record each active element with its host kind and the elements at 5 sampled points, without calling `blur()` or `focus()`, and stop on a cycle, on `body`, on a trap, or at the cap.
- **KBD-02** When the same element with host kind `plain` stays active for 3 consecutive Tabs, the system shall report `keyboard-trap` with status `incomplete` ("possible trap"), WCAG 2.1.2, and stop the walk; shadow hosts, iframes and native composite inputs (date, time, color, file, media with controls) shall never be reported as traps.
- **KBD-03** When an element has an `onclick` attribute or `role="button"`/`role="link"`, is neither focusable nor reached by the traversal, and contains no focusable descendant, the system shall report `unreachable-control` as a violation, WCAG 2.1.1.
- **KBD-04** When `elementFromPoint` at the focused element's sampled points returns, for at least one point, an element that is neither the element, a descendant nor an ancestor, the system shall report `focus-obscured` with status `incomplete`, WCAG 2.4.11, stating "fully" when all 5 points are covered and "partly (N of 5)" otherwise.

## Non-goals

- Auditing iframe content: axe runs in the main frame only, so iframes are not audited and nodes inside open shadow
  roots are described but `dom-only` (never mapped, never fixed).
- Fixing keyboard findings automatically: traps, unreachable `div` buttons and obscured focus need JavaScript or CSS
  changes, which are design decisions. They are reported with a suggestion.
- Crawling a whole site: one page per run keeps the loop bounded.
- Pixel diffing of screenshots: tests assert existence, PNG signature and dimensions only.
- Claiming full WCAG 2.2 AA coverage: axe automates one 2.2 AA criterion (`target-size`) and the keyboard checks add a
  heuristic for 2.4.11. `docs/coverage.md` lists the criteria that are not checked.
- Seeing what axe and the keyboard walk cannot see (layout, script errors, meaning).
- `focus-not-visible` (WCAG 2.4.7) and `--url` mode: M10 items, not part of v1.

## Questions resolved

**Library facts checked in Step 0** (`docs/api-notes.md`)

- `import axe from "axe-core"` typechecks with TypeScript 7 under `moduleResolution: "bundler"`; no `createRequire`
  fallback was needed. `axe.getRules` with the six tags returns 70 rules, 4 of them tagged `experimental`, so the
  selected set has 66 rules (AUD-02).
- A shadow-DOM node's `target` is `[["#host","button"]]`: more than one level, so it is `dom-only` (AUD-03).
- `chromium.executablePath()` returns a path even when that revision is not installed, so existence is always checked.
  Playwright's own Chromium (revision 1248) is not installed on the author's Mac; the Puppeteer headless shell 155 is
  used through `A11Y_BROWSER_PATH`.

**Plan decisions**

- P-1: a set but missing `A11Y_BROWSER_PATH` is `NO_BROWSER` (exit 3) naming the path, with no fall-through to
  Playwright's Chromium.
- P-3: axe `incomplete` findings get no fix outcome and are listed as "needs review"; keyboard findings get
  suggest-only outcomes.
- P-9: the no-network guard wraps `fetch` and `net.Socket.prototype.connect` and allows loopback only.
- P-16: keyboard impacts are `keyboard-trap` serious, `unreachable-control` serious, `focus-obscured` moderate, with
  WCAG 2.1.2, 2.1.1 and 2.4.11.

**Fixture and count notes**

- The real browser agreed with the inventory of spec 5.15 on the first run (15 violations across 8 rules, 1
  incomplete, 3 keyboard findings, walk stopped by `trap` on `#qty` after 11 steps). No count and no fixture CSS changed.
- `domIds` at baseline is `["email","main","qty"]`: the signup input has no `id` in source, so only the injected
  newsletter input carries `#email`. The "email twice" wording of spec 8.2 holds on a tree where `label-associate` has
  added the id; `[AUD-08]` asserts both states.
- `page.screenshot()` hides the caret by editing `style` on every `<input>`, which broke the mapping of `#qty`. The
  runner passes `caret: "initial"`; `[AUD-04]` asserts that node attributes are equal with and without a screenshot.
- A dom-only descriptor has `domTagIndex: -1` and `domTagCount: 0`. A status of 400 or more on the page is
  `PAGE_LOAD_FAILED`, and so is an axe run longer than 30 s.
- Playwright's `locator(tag).nth(i)` pierces open shadow roots while `document.querySelectorAll` does not, so a page
  with same-tag elements inside a shadow root could shift a watched index. The fixture has none; `docs/coverage.md` says so.
- Recordings: the key includes the page path check and the sorted watch list; `fixtures:record` stores a fixed URL,
  no screenshot and zero timings so files are byte-stable.

## Checklist

Test file per criterion. A criterion is covered when its ID starts a test name (`[ID]`) in the file.

| Criterion | Test file |
|---|---|
| AUD-01 | `tests/e2e/audit-fixture.e2e.test.ts`, `tests/unit/axe-config.unit.test.ts` |
| AUD-02 | `tests/unit/axe-config.unit.test.ts`, `tests/unit/fixture-inventory.unit.test.ts` |
| AUD-03 | `tests/e2e/audit-fixture.e2e.test.ts`, `tests/unit/source-map.unit.test.ts` |
| AUD-04 | `tests/e2e/audit-fixture.e2e.test.ts` |
| AUD-05 | `tests/e2e/cli.e2e.test.ts`, `tests/e2e/demo.e2e.test.ts`, `tests/unit/browser-resolve.unit.test.ts` |
| AUD-06 | `tests/unit/contracts.unit.test.ts`, `tests/unit/recorded-runner.unit.test.ts`, `tests/unit/tree-hash.unit.test.ts` |
| AUD-07 | `tests/unit/contracts.unit.test.ts`, `tests/unit/findings.unit.test.ts`, `tests/unit/recorded-runner.unit.test.ts` |
| AUD-08 | `tests/e2e/audit-fixture.e2e.test.ts`, `tests/unit/contracts.unit.test.ts` |
| AUD-09 | `tests/e2e/audit-fixture.e2e.test.ts` |
| AUD-10 | `tests/e2e/audit-fixture.e2e.test.ts`, `tests/e2e/verify-loop.e2e.test.ts`, `tests/unit/recorded-runner.unit.test.ts` |
| KBD-01 | `tests/e2e/keyboard-fixture.e2e.test.ts`, `tests/unit/keyboard-analyze.unit.test.ts` |
| KBD-02 | `tests/e2e/keyboard-fixture.e2e.test.ts`, `tests/unit/keyboard-analyze.unit.test.ts` |
| KBD-03 | `tests/e2e/keyboard-fixture.e2e.test.ts`, `tests/unit/keyboard-analyze.unit.test.ts` |
| KBD-04 | `tests/e2e/keyboard-fixture.e2e.test.ts`, `tests/unit/keyboard-analyze.unit.test.ts` |
