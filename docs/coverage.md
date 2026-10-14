# Coverage: what is checked and what is not

This tool helps find and fix common WCAG 2.2 AA failures. It is not a conformance audit and not legal advice.

## Checked by axe-core 4.14.0

axe runs with a tag-type `runOnly` of `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a` and `wcag22aa`. The selected set is
`axe.getRules(tags)` minus the rules tagged `experimental`: 66 rules (70 match the tags; `css-orientation-lock`,
`p-as-heading`, `table-fake-caption` and `td-has-header` are experimental and never run). No `best-practice` rule runs.
The success criteria these rules carry, with their rule ids (from the installed package, 2026-10-14):

- 1.1.1: aria-meter-name, aria-progressbar-name, image-alt, input-image-alt, object-alt, role-img-alt, svg-img-alt
- 1.2.1: audio-caption. 1.2.2: video-caption
- 1.3.1: aria-hidden-body, aria-required-children, aria-required-parent, definition-list, dlitem, list, listitem, td-headers-attr, th-has-data-cells
- 1.3.5: autocomplete-valid. 1.4.1: link-in-text-block. 1.4.2: no-autoplay-audio. 1.4.3: color-contrast. 1.4.4: meta-viewport. 1.4.12: avoid-inline-spacing
- 2.1.1: frame-focusable-content, scrollable-region-focusable, server-side-image-map. 2.1.3: scrollable-region-focusable
- 2.2.1: meta-refresh. 2.2.2: blink, marquee. 2.4.1: bypass. 2.4.2: document-title. 2.4.4: area-alt, link-name
- 2.5.3: label-content-name-mismatch. 2.5.8: target-size
- 3.1.1: html-has-lang, html-lang-valid, html-xml-lang-mismatch. 3.1.2: valid-lang. 3.3.2: form-field-multiple-labels
- 4.1.2: the ARIA name, role and value rules, button-name, input-button-name, label, select-name, summary-name, duplicate-id-aria, nested-interactive and others

4.1.1 Parsing was removed from WCAG 2.2. Of the new 2.2 AA criteria, axe automates one: 2.5.8 Target Size (Minimum),
through `target-size`, which is enabled by the `wcag22aa` tag.

## Checked by the keyboard heuristics

| Check | Criterion | Status in the report |
|---|---|---|
| `unreachable-control`: an element with `onclick`, `role="button"` or `role="link"` that is not focusable, was not reached by Tab and has no focusable descendant | 2.1.1 Keyboard | violation |
| `keyboard-trap`: the same plain element stays active for 3 consecutive Tabs | 2.1.2 No Keyboard Trap | needs review (`incomplete`), "possible trap" |
| `focus-obscured`: at least one of 5 sampled points of the focused element is covered by another element | 2.4.11 Focus Not Obscured (Minimum) | needs review (`incomplete`), "fully" or "partly (N of 5)" |

Keyboard findings are reported with a suggestion and never fixed. The heuristics are validated on the fixture storefront only.
Shadow hosts, iframes and native composite inputs (date, time, color, file, media with controls) are never reported as traps.

## Checked by the LLM tasks

Two tasks, both proposals that deterministic gates and the browser re-audit then check for presence: an `alt` text for
an image (1.1.1) and an accessible name for an icon-only button or link or an unlabeled text input (4.1.2, 2.4.4). Whether
the wording is right is a human decision, so every such fix is "verified, present, needs human review".

## Not checked

- 2.5.7 Dragging Movements, 3.2.6 Consistent Help, 3.3.7 Redundant Entry and 3.3.8 Accessible Authentication (Minimum), the
  other new AA criteria of WCAG 2.2.
- Every criterion without a rule in the selected set, and everything an automated check cannot judge: whether alt text is
  right, whether reading order makes sense, captions' accuracy, cognitive load. Deque's own study of its audits reports that
  automated testing found 57% of issues by volume (a vendor study of its own engine); the older rule of thumb is 20 to 30%
  of success criteria. Either way, most barriers need a person.
- Layout, script errors and visual regressions. The acceptance gate compares axe findings and the three keyboard checks,
  so "verified" means no new detectable failure appeared, not that nothing else changed.

## Limits of what the tool sees

- **Iframes are not audited.** axe runs in the main frame only (no adapter package, ADR 0007).
- **Shadow DOM:** nodes inside open shadow roots are audited, but their target is a nested array, so they are `dom-only`:
  they cannot be mapped to source and are never fixed. A page with same-tag elements inside a shadow root can also shift
  the index of a watched node, because Playwright's `locator(tag).nth(i)` pierces open shadow roots while
  `document.querySelectorAll` does not. The fixture has none.
- **One page per run**, served from a scratch copy of `--src`. Static HTML only: JSX, Vue, Svelte and templated sources are not mapped.
- **Contrast fixes** are made only for an inline `style` color. The new color is the nearest one of the same hue and
  saturation that meets the ratio, found by stepping HSL lightness, which is not perceptually uniform: the first step that
  meets the ratio is taken and printed, and the fix is flagged for design review. External stylesheets are not edited.
- **`lang`** is fixed only with an explicit `--lang` or a page signal (`content-language`, `og:locale`); the signal case is
  flagged `inferred-lang`. Without either, the finding is suggest-only.
- **Vision:** the fake provider never sees pixels; whether a real model describes an image well is untested offline.
