# Source mapping and fixes

## Context

A finding reaches a source file only through parse5: the page file is parsed with `sourceCodeLocationInfo`, and a DOM
node maps to an element by `data-a11y-source`, then by tag ordinal, then by a unique attribute signature. Nothing is
guessed: an ambiguous or missing candidate means no patch. A fix is a plan of attribute edits (or one `<title>`
insert) at those offsets. Deterministic fixers and LLM-proposed values both produce plans; code builds the diff, a
bounds gate checks it, and a run-level id allocator keeps generated ids unique. The strategy catalog fixes the order:
deterministic first, then LLM, then suggest-only.

## Acceptance criteria

- **MAP-01** When a node carries `data-a11y-source` in the form `file:line:col` and an element with the same tag starts at that line and column in that file, the system shall map it with method `attribute`; otherwise it shall be `Unmapped("attribute-mismatch")`.
- **MAP-02** When the DOM count of the node's tag equals the source count in the page file and the attribute signature of the ordinal candidate equals the node's, the system shall map by `ordinal`.
- **MAP-03** When ordinal mapping is not possible, the system shall map by `signature` only when exactly one element in the page file has the same tag and attribute signature (and text, when the node has text); zero candidates shall be `no-candidate` and two or more `ambiguous`; the system shall never pick a closest match.
- **MAP-04** The page resolver shall be pure over strings with an injected `exists`, shall map `/` to `index.html`, `/x` to `x.html` or `x/index.html`, and shall return `no-page-file` for paths containing `..`, absolute paths, backslashes, or a missing file.
- **MAP-05** A `SourceLocation` shall carry UTF-16 offsets for the element, the start tag and every attribute, plus 1-based lines and columns, such that splicing at the offsets reproduces the element.
- **FIX-01** The catalog shall list strategies per rule in a fixed order with deterministic strategies before LLM strategies, and the loop shall try them in that order, stopping at the first accepted candidate.
- **FIX-02** When `html-has-lang` is found and `<html>` exists in source, the fixer shall add `lang="<lang>"` to its start tag and touch nothing else, where `<lang>` is the explicit `--lang` or, failing that, a `content-language` or `og:locale` signal in the source (then flagged `inferred-lang`); with neither, the finding shall be suggest-only with reason `lang-unknown`.
- **FIX-03** When `document-title` is found and the page has an `<h1>` with text and an explicit `<head>`, the fixer shall insert `<title>` with the collapsed `h1` text (1 to 120 chars); otherwise the finding shall be suggest-only.
- **FIX-04** When `label` is found, the system shall try `label-associate` (source-only: the id comes from `name` or `field-<n>`, unique in the file, `domIds` not consulted), then `label-fresh-id` (same adjacency precondition or a dangling or duplicated `for`; the id allocated as the smallest `<base>-<n>` absent from the file, from `domIds` and from the ids reserved in this run), then `aria-label-llm`; on the fixture's email input the first shall be rejected by the gate and the second accepted.
- **FIX-05** When `button-name` or `link-name` is found, the system shall use an LLM-proposed `aria-label` and no deterministic strategy, because every attribute axe accepts as a name is absent when the rule fires.
- **FIX-06** When `image-alt` is found, the system shall request an `alt-text` proposal, add `alt="<alt>"` for `informative` and flag the fix `needsHumanReview` with status `verified-present-needs-review`; for `decorative` it shall produce a `suggest-only` outcome with reason `decorative-needs-decision` and never write `alt=""`; and it shall reject `decorative` when the image is the only content of a control.
- **FIX-07** When `color-contrast` is found and the reported foreground color is declared in the element's inline `style`, the fixer shall replace it with the nearest color of the same hue and saturation whose ratio meets the expected ratio and flag the fix `needsHumanReview` with reason `design-review`; otherwise the finding shall be suggest-only with the suggested color.
- **FIX-08** Every candidate's patch shall parse to exactly one file named `a/<file>` and `b/<file>` (relative to the source root), apply strictly (fuzz 0) to reproduce the expected text, change nothing outside at most 3 touched ranges, and contain only attribute edits inside their start tag or a single `<title>` element insert; a candidate failing any of these shall be `gate-rejected: patch-out-of-bounds` and never applied.
- **FIX-09** Findings whose strategy is suggest-only shall produce a suggestion text and a location but no patch.
- **FIX-10** Generated ids shall come from one allocator per run, seeded with the page file's ids and `domIds` and fed with every accepted candidate's generated ids, so that two candidates in one run never generate the same id.

## Non-goals

- JSX, Vue, Svelte or any templated source: v1 maps static HTML only. A generated site is audited on its authored
  HTML, or the build emits `data-a11y-source="file:line:col"` (a five-line example for 11ty and Astro is in
  `docs/architecture.md`).
- Contrast fixes in external stylesheets: only an inline `style` color is fixed, by HSL lightness. Other contrast
  findings are suggest-only with the suggested color.
- A deterministic name strategy for `button-name` and `link-name`: axe already accepts a non-empty `title`, so a
  strategy built on it can never fire.
- `--accept-decorative`: a `decorative` verdict is never applied in v1.
- Writing needs-review fixes (`--write-llm`) and Overlay-style runtime patching.

## Questions resolved

**Library facts checked in Step 0**

- parse5 8.0.1: `attrs[name]` covers the whole `name=value` text, quotes included; keys are lower-cased; offsets count
  the original text including `\r` and are UTF-16 code units (an emoji is 2). A leading BOM is parsed as text and makes
  an explicit `<html>` implicit, so the index parses the text without the BOM and shifts every offset by one.
- `diff` 9.0.0: `createTwoFilesPatch("a/x.html", "b/x.html", ...)` passes `git apply --check`; the insert-plus-delete
  hunk shape of two identical neighbouring lines is accepted by the gate. `applyPatch` runs with `fuzzFactor: 0`.

**Plan decisions**

- P-4: findings are ordered by (file, start offset), then unmapped ones; ties keep snapshot order.
- P-10: the `--out` directory is excluded from every scratch copy and from the tree hash when it lies inside `--src`.
- P-14: `IdAllocator.has(id)` means "reserved in this run". `label-associate` takes `name`, else `field-<n>`, as the
  first value absent from the file and not reserved, and never reads the DOM; `label-fresh-id` uses `allocate()`.

**Behaviour the spec left open**

- `pageFileFor` also rejects `.` and empty segments, a drive letter and a non-HTML target; `/x/` maps to `x/index.html`.
- The text tie-breaker of the signature step runs only when the signature has two or more candidates and compares the
  source text cut at 200 characters. A malformed `data-a11y-source` value is ignored; a well-formed one that does not
  resolve is `attribute-mismatch`.
- `surroundingTextOf` is the parent's collapsed text (an `<img>` has none of its own); a top-level element has none.
- The bounds gate adds a check to item 3: the patched text must equal `applyEdits(original, edits)` (`edits-mismatch`),
  because otherwise a zero-length attribute range could carry arbitrary bytes. It also refuses `\r` in replacements and
  an attribute edit outside its start tag. Failure codes are stable strings; the loop maps all of them to `patch-out-of-bounds`.
- `attributeEdit` inserts after the last non-space character before `>` or `/>` and keeps parse5's lower-case name.
- `contrast-inline` replaces only the value of the `color` declaration, keeps `!important`, stays suggest-only when the
  style value contains `&`, uses the 0.04045 sRGB threshold and starts lightness steps from the exact HSL value (the
  rounded value would give `#757575` instead of `#767676`).
- `title-from-h1` also fills an empty `<title>`; `html-lang` normalizes a page signal (`_` to `-`, primary subtag
  lower-cased) and ignores invalid values; `label-fresh-id` skips when the adjacent label's `for` resolves to exactly
  one element in `domIds`. Suggest-only entries are named `<rule>-advice`.

**Fixture and count notes**

- After `label-associate` the injected `#email` is no longer flagged by axe, because `label[for="email"]` now exists.
  The selector-drift case of `[VER-01]` therefore uses a synthetic `id="signup-email"` edit; recorded in `docs/api-notes.md`.
- Both label strategies share the adjacency precondition. Strategy 1 is source-only, which is why the duplicate id
  appears (ADR 0006); strategy 2 consults `domIds`.

## Checklist

Test file per criterion. A criterion is covered when its ID starts a test name (`[ID]`) in the file.

| Criterion | Test file |
|---|---|
| MAP-01 | `tests/unit/source-map.unit.test.ts` |
| MAP-02 | `tests/unit/source-map.unit.test.ts` |
| MAP-03 | `tests/unit/source-map.unit.test.ts` |
| MAP-04 | `tests/unit/page-file.unit.test.ts` |
| MAP-05 | `tests/unit/contracts.unit.test.ts`, `tests/unit/source-map.unit.test.ts` |
| FIX-01 | `tests/unit/fix-loop.unit.test.ts`, `tests/unit/fixers.unit.test.ts` |
| FIX-02 | `tests/unit/contracts.unit.test.ts`, `tests/unit/fixers.unit.test.ts` |
| FIX-03 | `tests/unit/fixers.unit.test.ts` |
| FIX-04 | `tests/unit/fixers.unit.test.ts` |
| FIX-05 | `tests/unit/fixers.unit.test.ts`, `tests/unit/llm-strategies.unit.test.ts` |
| FIX-06 | `tests/unit/fix-loop.unit.test.ts`, `tests/unit/llm-strategies.unit.test.ts` |
| FIX-07 | `tests/unit/contrast.unit.test.ts`, `tests/unit/fixers.unit.test.ts` |
| FIX-08 | `tests/unit/bounded-patch.unit.test.ts`, `tests/unit/fix-loop.unit.test.ts` |
| FIX-09 | `tests/unit/fix-loop.unit.test.ts`, `tests/unit/fixers.unit.test.ts` |
| FIX-10 | `tests/unit/fix-loop.unit.test.ts`, `tests/unit/id-allocator.unit.test.ts` |
