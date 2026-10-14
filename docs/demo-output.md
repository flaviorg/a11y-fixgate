# Demo output

The real output of `npm run demo -- --browser` and of `npm run demo`, captured on 2026-10-14 on an Apple-silicon Mac, Node 24.21.0, with the Puppeteer headless
shell 155.0.8059.39 as the Chromium (`A11Y_BROWSER_PATH`). The LLM answers are scripted answers from the fake provider (`docs/fake-provider.md`); the audits
in the first block are real. Nothing below was edited. The port in the `Page:` line changes on every run.

## `npm run demo -- --browser` (real Chromium run)

```
$ npm run demo -- --browser

a11y-fixgate demo | audit: Chromium (A11Y_BROWSER_PATH) | LLM: fake, strict (fixtures/llm/storefront.json) | lang: en
Page: fixtures/storefront/index.html served at http://127.0.0.1:51487/  axe-core 4.14.0  tags: wcag2a wcag2aa wcag21a wcag21aa wcag22a wcag22aa

Baseline: 15 axe violations (8 rules), 1 needs-review, 3 keyboard findings
  document-title 1 | html-has-lang 1 | link-name 2 | label 3 | button-name 1 | image-alt 4 | color-contrast 1 | target-size 2
  needs-review: color-contrast h1
  keyboard: focus-obscured a.skip | unreachable-control div.btn | keyboard-trap #qty
Mapping: 18 mapped (ordinal 12, signature 6), 1 unmapped

Fix loop (each candidate verified in a scratch copy, re-audited, judged on fingerprints; caps: 60 candidates, 40 LLM calls, 600 s)
 [1] document-title      title-from-h1              deterministic  accepted   <title>Orbit Outfitters</title>  verified
 [2] html-has-lang       html-lang                  deterministic  accepted   lang="en"  verified
 [3] focus-obscured      focus-obscured-advice      suggest-only   suggest    Focused body > a.skip is fully (5 of 5 points) covered by body > header > div.banner > h1; add... (catalog)
 [4] link-name           aria-label-llm             llm            accepted   aria-label="Orbit Outfitters home"  verified present, needs review
 [5] link-name           aria-label-llm             llm            REJECTED   aria-label="Shop deals" passed every value gate; re-audit: new-violation: label-content-name-mismatch
     link-name           aria-label-llm             llm            accepted   aria-label="Sale: shop deals" (attempt 2)  verified present, needs review
 [6] label               aria-label-llm             llm            accepted   aria-label="Search products"  verified present, needs review
 [7] button-name         aria-label-llm             llm            accepted   aria-label="Open cart"  verified present, needs review
 [8] image-alt           alt-text-llm               llm            accepted   alt="Orbit Outfitters autumn collection banner"  verified present, needs review
 [9] image-alt           alt-text-llm               llm            gate-rejected (alt-is-filename)
     image-alt           alt-text-llm               llm            accepted   alt="Green waterproof trail jacket with hood" (attempt 2)  verified present, needs review
[10] unreachable-control unreachable-control-advice suggest-only   suggest    Use <button> instead of <div onclick>; or add tabindex="0", role="button" and a keydown handler for Enter... (catalog)
[11] image-alt           alt-text-llm               llm            accepted   alt="Green trail jacket, kids size"  verified present, needs review
[12] color-contrast      contrast-inline            deterministic  accepted   color:#9a9a9a -> #767676 (2.81:1 -> 4.54:1 on #ffffff)  verified present, design review
[13] image-alt           alt-text-llm               llm            suggest    decorative proposed (alt=""): visual separator (decorative-needs-decision)
[14] label               label-associate            deterministic  REJECTED   id="email" / for="email"; re-audit: new-incomplete: duplicate-id-aria
     label               label-fresh-id             deterministic  accepted   id="email-2" / for="email-2"  verified
[15] target-size         target-size-advice         suggest-only   suggest    Target .step-down is 16 by 16 px; the minimum is 24 by 24 px (catalog)
[16] target-size         target-size-advice         suggest-only   suggest    Target .step-up is 16 by 16 px; the minimum is 24 by 24 px (catalog)
[17] keyboard-trap       keyboard-trap-advice       suggest-only   suggest    Focus stayed on #qty for 3 Tabs; keydown handlers that cancel Tab must let it through or provide an exit (Esc) (catalog)
[18] label               unmapped                   no patch       no-candidate

Combined audit (11 accepted fixes merged, 0 conflicts): 4 axe violations remaining (image-alt 1, target-size 2, label 1), 1 needs-review, 3 keyboard findings, 0 new
Accepted 11 (verified 3, needs human review 8: 7 LLM + 1 design review) | rejected 2 | gate-rejected 1 (retried) | suggest-only 6 | unmapped 1
Screen reader view, a.promo:  - link  ->  + link "Sale: shop deals"
Remaining in source: 8 critical (label, button-name, image-alt), 8 serious (document-title, html-has-lang, link-name, unreachable-control, color-contrast, target-size). Fixable by fixes.patch: 11.

Outputs: reports/demo/report.html  fixes.patch (1 file)  results.sarif (18 results)  audit.json  screenshots/page.png, page.after.png
Finished in 3.3 s (Chromium, 15 audits). npm run demo without flags replays these recordings in under 10 s.
```

stderr of the same run holds one JSON log line per event, including the key of each of the 10 LLM calls (`"component":"llm","event":"call"`).

## `npm run demo` (recorded mode, no browser)

The same pipeline over the recorded audits of `tests/fixtures/audits`. The first lines are the same as above except for the mode in the header and
the port; the last lines read:

```
Accepted 11 (verified 3, needs human review 8: 7 LLM + 1 design review) | rejected 2 | gate-rejected 1 (retried) | suggest-only 6 | unmapped 1
Screen reader view, a.promo:  - link  ->  + link "Sale: shop deals"
Remaining in source: 8 critical (label, button-name, image-alt), 8 serious (document-title, html-has-lang, link-name, unreachable-control, color-contrast, target-size). Fixable by fixes.patch: 11.

Outputs: reports/demo/report.html  fixes.patch (1 file)  results.sarif (18 results)  audit.json
Finished in 0.1 s (15 audits replayed from tests/fixtures/audits; recorded mode (no browser)). npm run demo -- --browser runs them in a real Chromium.
```

`tests/e2e/demo.e2e.test.ts` checks both modes: exactly two `REJECTED` lines (the promo link with `label-content-name-mismatch`, then the email field with
`duplicate-id-aria`), the totals line, and that browser mode logs the same LLM keys as recorded mode.

## How to read it

- `[5]` is the promo link. The scripted model proposed `aria-label="Shop deals"`. It passed every value gate and was rejected by the browser re-audit because the
  accessible name no longer contained the visible text "Sale" (WCAG 2.5.3). The verdict went back as feedback and attempt 2 was accepted.
- `[14]` is the email field. The source-only strategy added `id="email"`; a script on the page injects the same id, so the re-audit found `duplicate-id-aria`
  (ADR 0006). The DOM-aware strategy allocated `email-2` and was accepted.
- "verified" means: re-audited in a real browser, the target failure is gone and no new axe or keyboard finding (violation or needs-review) appeared. It does not see
  layout, script errors or meaning, and LLM-written text is marked for human review.
- `Remaining in source` counts what the files still contain: nothing was written, so every finding is still there and `fixes.patch` resolves 11 of them.
