# 0003. Patches are built by code from a value, and bounded

- **Status:** accepted (2026-10-08, decision D-03).

## Context

If a model wrote the unified diff, any hunk could change anything: add a script, rewrite an element, touch a second file. Even a well-behaved model drifts
(line numbers, whitespace). A reviewer cannot read every diff of a run, so the property "this patch changes only what it claims" has to be mechanical.

## Decision

A fixer or the LLM strategy returns a plan: a list of edits `{ range, replacement, kind, startTag }` at parse5 offsets. `applyEdits` splices the original text, and
`createTwoFilesPatch("a/<file>", "b/<file>", ...)` makes the diff. The bounds gate then checks every candidate before it is audited:

1. the patch parses to exactly one file named `a/<file>` and `b/<file>`;
2. it applies strictly (fuzz 0) and reproduces the patched text;
3. the patched text equals `applyEdits(original, edits)`, so a zero-length range cannot carry arbitrary bytes;
4. it changes nothing outside at most 3 touched ranges, and contains only attribute edits strictly inside their start tag, or one `<title>` insert;
5. replacements carry no `\r`, and attribute values are escaped.

A candidate that fails is `gate-rejected: patch-out-of-bounds` and never applied or audited.

## Consequences

- The LLM's blast radius is one attribute value in one start tag, after the value gates.
- `fixes.patch` is re-created from the merged edits with repository-root-relative names, so `git apply` works from the repository root (checked in
  `tests/e2e/write.e2e.test.ts` with `git apply --check`).
- The gate is tested with adversarial patches (a line outside the range, a patch that does not apply, two files, a rewritten element) in
  `tests/unit/bounded-patch.unit.test.ts`.
- Sequential application of several diffs would fail for edits a few lines apart, so combining is done on edits, not on diffs.

## Alternatives

- Trust a model-written diff and check it afterwards: the same gate would be needed, plus a way to explain failures.
- Whole-file rewrites by the model: unreviewable and not mappable to findings.
