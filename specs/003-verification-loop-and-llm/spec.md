# Verification loop and LLM

## Context

Every candidate is verified in its own scratch copy: serve it, audit it again, and let `judge(baseline, after, target)`
compare fingerprints. The gate accepts only when the target is gone and nothing new appeared, not even an `incomplete`
item. The accepted edits are merged per file at the edit level, applied once and audited once more (the "after" state).
The LLM is a value source behind a port: a scripted fake keyed by a hash of task plus input (strict in tests and the
demo, lenient by default in the CLI), a `none` provider, and an OpenAI-compatible client over raw `fetch`. Every
proposal passes a Zod shape and value gates before it becomes an edit; an acceptance-gate rejection of attempt 1 starts
attempt 2 with the verdict as feedback. Caps bound the candidates, the LLM calls and the wall clock.

## Acceptance criteria

- **VER-01** A finding's fingerprint shall be `fnv1a64("v1|" + ruleId + "|" + anchor)`, where the anchor is the source anchor (`src:file#tag[ordinal]`) when mapped, or the start tag signature (tag plus sorted attributes, descendants excluded) when unmapped; it shall never include the status or a CSS selector, and the same value shall be used in findings, finding sets, SARIF and the gate's target.
- **VER-02** The gate shall accept a candidate only when the target fingerprint is absent from both `violations` and `incomplete` after the fix, no violation fingerprint is new, no keyboard fingerprint is new, no baseline violation has moved to `incomplete`, and no incomplete fingerprint is new unless `--allow-new-incomplete`, in which case new incomplete entries that are not downgraded violations become warnings.
- **VER-03** If a candidate removes the target but introduces a new violation, a new incomplete finding or a downgraded violation, then the gate shall reject it with the reason (`new-violation`, `new-incomplete`, `violation-downgraded`, `new-keyboard-finding`) and the list of new fingerprints, and the loop shall continue with attempt 2 of the same LLM strategy (with the verdict as feedback) when attempt 1 was rejected, otherwise with the next strategy.
- **VER-04** Each candidate shall be verified in its own scratch copy of the source root (symlinks never copied), served on an ephemeral loopback port, and the original source root shall remain byte-identical unless `--write` is given.
- **VER-05** When the loop ends, the system shall merge the edits of all accepted candidates per file at the edit level, mark as `conflict` a candidate whose ranges overlap an earlier one or touch the same start tag (`overlap`) or whose generated id collides (`id-collision`), apply the merged edits once to the baseline files, emit one unified diff per file, serve and audit the combined tree once, and use that snapshot as the "after" state; when the combined audit disagrees with the per-candidate verdicts, `--write` shall refuse with `COMBINED_MISMATCH`.
- **VER-06** Candidates shall always be built from the baseline source text, LLM strategies shall get at most 2 attempts, and the loop shall stop accepting after `--max-fixes`.
- **VER-07** The loop shall stop verifying after `--max-candidates` candidates, stop calling the provider after `--max-llm-calls` calls, and stop after `--deadline` seconds, each remaining finding becoming `skipped` with the matching reason, and the caps shall never change the exit code.
- **VER-08** Every project file the tool reads for an LLM input or writes on `--write` shall be resolved with realpath containment inside the source root, refused when it is a symbolic link, and typed by magic bytes when it is an image.
- **LLM-01** While `LLM_PROVIDER` is unset or `fake`, the system shall use the scripted provider and make no network call; in strict mode it shall fail with `UNSCRIPTED_LLM_CALL` naming the task and known keys when no response matches, and in lenient mode it shall yield a `suggest-only` outcome with reason `no-scripted-answer`.
- **LLM-02** When a proposal fails the Zod schema or a value gate, or its candidate is rejected by the acceptance gate, the system shall count a failed attempt and retry once with the rejection reasons as feedback; after two failures it shall mark the strategy `gate-rejected: llm-invalid` (value or schema) or keep the `rejected` outcome (acceptance gate) and continue with the next strategy.
- **LLM-03** The alt gate shall reject values that are empty for informative images, longer than 125 characters, contain `<`, `>`, `://` or a newline, equal the file name stem, start with "image of", "picture of", "photo of", "graphic of" or "icon of", or equal the adjacent text; and shall reject `decorative` inside a control without another name.
- **LLM-04** The control-name gate shall reject values that are empty, longer than 80 characters, contain markup or a URL, equal the href, or are in the generic list.
- **LLM-05** When an image under 2 MB with a supported type is available inside the source root, the `alt-text` input shall carry its bytes, hash and type, and the fake shall record that the image was present; otherwise `image` shall be `null`.
- **LLM-06** When `LLM_PROVIDER=openai-compatible`, the client shall POST to `<LLM_BASE_URL>/chat/completions` (`https:`, or `http:` on loopback only) with JSON mode, the image as `image_url`, a timeout, at most 2 attempts, the body merged with `LLM_REQUEST_OVERRIDES`, and shall never include the key in any log, error or output; without `LLM_API_KEY` or `LLM_MODEL` the CLI shall exit 2.
- **LLM-07** The fake shall compare the stored prompt hash with the current prompt and fail with `FIXTURE_PROMPT_DRIFT` on mismatch; prompts shall wrap page content in `<untrusted-content>` delimiters.
- **LLM-08** While `LLM_API_KEY` is absent, `test:live` shall skip; with a key, it shall assert only that real proposals pass the gates.
- **LLM-09** Every LLM input field shall be derived from the source files (surrounding text from the mapped element's parent, page title from the source, image bytes from disk), so that the fake's keys are identical in recorded and browser mode.
- **LLM-10** When the provider is `none`, every LLM strategy shall end as `suggest-only` with reason `llm-disabled`, no network call shall be made, and the run shall exit 0.

## Non-goals

- An autonomous agent: the pipeline is fixed, with two prompt tasks, bounded retries, no planning and no tool use by
  the model. The README says "LLM-assisted fixer", not "agent".
- Proving that an LLM text is correct: the browser proves presence, a human confirms meaning. Every LLM value is
  `verified-present-needs-review` and is never written by `--write` in v1.
- Tests that compare free LLM text: tests assert structure, gates and numbers. `test:live` asserts only that real
  proposals pass the gates.
- A measured evaluation of proposal quality (`eval:live`) and an Anthropic provider: M10 items. `docs/eval.md` says no
  evaluation has run.
- Vision quality is not tested offline: the fake records that the image was present, nothing more.

## Questions resolved

**Plan decisions**

- P-12: `judge(baseline, after, target, opts?: { allowNewIncomplete?: boolean })`.
- P-13: `combineEdits(baseline, accepted, domIds)` takes `domIds` for the id-collision check.
- P-15: the `rejected` outcome carries `newFindings: Array<{ fingerprint; ruleId; anchor }>` so the summary, logs and
  report can name `label-content-name-mismatch` and `duplicate-id-aria`.
- `--llm none` yields 8 LLM suggest-only outcomes on the storefront, not the 9 mentioned in early notes: the third
  `label` strategy is never reached because `label-fresh-id` is accepted.

**Gate and loop behaviour the spec left open**

- `new-incomplete` is raised only for brand-new incomplete entries. A downgrade alone gives `["violation-downgraded"]`
  with or without `--allow-new-incomplete`; a target that moves to `incomplete` gives `target-still-present` plus
  `violation-downgraded`. Warnings are `collateral-fix:<fp>` and `new-incomplete:<fp>`.
- Before every candidate the loop checks the deadline, `max-fixes` and `max-candidates`; before every provider call it
  checks the deadline, `max-fixes` and `max-llm-calls`. The bounds gate runs before the cap check, so an
  out-of-bounds plan is never audited. A deterministic or suggest-only strategy costs nothing after a cap.
- An `unavailable` attempt 1 is retried; an `unavailable` attempt 2 records `gate-rejected: llm-unavailable` and trips
  the circuit breaker for later LLM strategies. The provider failure kinds are `timeout`, `server_error`, `network`,
  `rate_limited`, `invalid_json`, `bad_request` and `http_error`; 4xx other than 429 are not retried.
- Feedback to attempt 2 is `<reasons joined by ", ">: <distinct new rule ids>` after an acceptance rejection, or the
  gate reason after a value-gate rejection. It goes into the prompt, never into the key (`LlmCallContext.feedback`).
- Gates: `decorative-inside-control` applies when the control has no other name; the filename check strips a trailing
  image extension; accepted values are trimmed. Image paths resolve against the page URL exactly as the browser does,
  against a sentinel origin, percent-decoded, and are then read only through `readInsideRoot`.
- Page fields enter the prompt as JSON with every `<` escaped, so page text cannot close `<untrusted-content>`.
- A combine conflict caused by an id already in the baseline file or in `domIds` names `id:<id>` as the earlier owner.
- Zod 4's `z.url()` accepts `javascript:` and `file:`, so `LLM_BASE_URL` has a protocol refinement (https, or http on
  loopback only).

**Fixture and count notes**

- Counts hold as in spec 5.15: 13 verified candidates, 15 browser audits with the baseline and the combined audit, 10
  LLM calls (rows 4 and 17 twice), accepted 11 (verified 3, needs human review 8), rejected 2, gate-rejected 1 retried.
- A bug found by the e2e: the screenshot changed the DOM, so every candidate was rejected with `new-keyboard-finding`
  (see spec 001). A logger bug was fixed too: `child({ component })` kept the parent's component.
- No real provider has been run (no key in this environment); the fixture answers are written by hand.

## Checklist

Test file per criterion. A criterion is covered when its ID starts a test name (`[ID]`) in the file.

| Criterion | Test file |
|---|---|
| VER-01 | `tests/unit/acceptance-gate.unit.test.ts`, `tests/unit/contracts.unit.test.ts`, `tests/unit/fingerprint.unit.test.ts` |
| VER-02 | `tests/e2e/verify-loop.e2e.test.ts`, `tests/unit/acceptance-gate.unit.test.ts` |
| VER-03 | `tests/e2e/verify-loop.e2e.test.ts`, `tests/unit/acceptance-gate.unit.test.ts`, `tests/unit/fix-loop.unit.test.ts` |
| VER-04 | `tests/unit/fix-loop.unit.test.ts`, `tests/unit/run-audit.unit.test.ts`, `tests/unit/scratch.unit.test.ts` |
| VER-05 | `tests/unit/combine.unit.test.ts`, `tests/unit/run-audit.unit.test.ts`, `tests/unit/write-outputs.unit.test.ts` |
| VER-06 | `tests/unit/fix-loop.unit.test.ts` |
| VER-07 | `tests/unit/fix-loop.unit.test.ts`, `tests/unit/run-audit.unit.test.ts` |
| VER-08 | `tests/unit/llm-strategies.unit.test.ts`, `tests/unit/safe-read.unit.test.ts` |
| LLM-01 | `tests/unit/fake-provider.unit.test.ts` |
| LLM-02 | `tests/unit/contracts.unit.test.ts`, `tests/unit/fix-loop.unit.test.ts`, `tests/unit/gates.unit.test.ts`, `tests/unit/llm-strategies.unit.test.ts` |
| LLM-03 | `tests/unit/gates.unit.test.ts` |
| LLM-04 | `tests/unit/gates.unit.test.ts` |
| LLM-05 | `tests/unit/fake-provider.unit.test.ts`, `tests/unit/llm-strategies.unit.test.ts` |
| LLM-06 | `tests/unit/cli-args.unit.test.ts`, `tests/unit/contracts.unit.test.ts`, `tests/unit/openai-compatible.unit.test.ts` |
| LLM-07 | `tests/unit/contracts.unit.test.ts`, `tests/unit/fake-provider.unit.test.ts` |
| LLM-08 | `tests/live/llm.live.ts` |
| LLM-09 | `tests/e2e/demo.e2e.test.ts`, `tests/unit/llm-strategies.unit.test.ts`, `tests/unit/source-map.unit.test.ts` |
| LLM-10 | `tests/e2e/cli.e2e.test.ts`, `tests/unit/none-provider.unit.test.ts` |
