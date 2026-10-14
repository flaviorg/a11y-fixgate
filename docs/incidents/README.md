# Incidents

Only things that really went wrong while building this repository are listed here. Each entry says what happened, how it was found and what
changed. The template is at the end.

## 1. The screenshot changed the page it photographed (chunk 5)

`page.screenshot()` hides the text caret by writing `style=""` on every `<input>`. The baseline was the only audit with a screenshot, so it
saw different attributes than every candidate audit. The baseline therefore mapped `#qty` as `no-candidate`, and every candidate was rejected
with `new-keyboard-finding`. Earlier recordings were made without a screenshot, which hid it. Found by the
first real-browser run of the fix loop. Fix: the runner passes `caret: "initial"`, and `[AUD-04]` asserts that node attributes are equal with and
without a screenshot. Noted in `docs/api-notes.md`.

## 2. The logger's `child({ component })` kept the parent's component (chunk 5)

`component` is a reserved field, so a child logger silently kept the parent's value and every loop and LLM line would have carried the root
component (spec 5.12 requires `loop`, `llm`, `runner`). Found while writing the first test that read the `call` events. Fix: `child()` switches
the component, with a regression test in `tests/unit/redact.unit.test.ts`.

## 3. Redaction marked ordinary words as keys (chunk 1)

The generic `sk-` pattern matched the end of words such as `risk-assessment-framework-for-everyone`. Fix: a lookbehind on the four key patterns,
with the specific prefixes first, and a test for both directions.

## 4. A redaction marker survived escaping as markup (chunk 6)

`redactText` writes `<redacted:sk-or-v1->`. The report escaped a string first and redacted it second, so the marker's `<` and `>` landed in the page as
a stray tag. Found by the report unit test. Fix: `escapeHtml` redacts first and then escapes.

## 5. A racy scratch-directory test (chunk 5)

`[VER-04] a failed create leaves no scratch directory behind` watched the shared temp directory and failed once while other test files created
scratch copies in parallel. Fix: the test uses a private `TMPDIR`.

## Template

```
## <n>. <one line>
What happened, with the evidence.
How it was found.
What changed, and the test that now covers it.
```
