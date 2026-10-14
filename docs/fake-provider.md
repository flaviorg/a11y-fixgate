# The fake LLM provider

Tests, the demo and the default CLI never call a model. A scripted provider answers instead, so the whole loop, including the
two headline rejections, runs offline and identically every time.

## Providers

- `fake` (`src/llm/fake-provider.ts`): loads one fixture file, validated with Zod at load, and answers by key. In **strict**
  mode (`--strict-fake`, every test, the demo) an unknown key throws `UnscriptedLlmCallError` (`UNSCRIPTED_LLM_CALL`, exit 4),
  naming the task and the known keys. In **lenient** mode (the CLI default) it resolves to `no-proposal: no-scripted-answer`,
  which the loop turns into a `suggest-only` outcome. In both modes a changed prompt throws `FIXTURE_PROMPT_DRIFT`.
- `none` (`src/llm/none-provider.ts`): every task resolves to `no-proposal: llm-disabled` without touching the network; strategies
  end as `suggest-only` with "run with a provider to get a proposal".
- `openai-compatible` (`src/llm/openai-compatible.ts`): `POST {baseUrl}/chat/completions` over raw `fetch`. Unit-tested with an
  injected `fetch`; `npm run test:live` runs the four fixture alt texts against a real model when `LLM_API_KEY` is set and
  asserts only that the proposals pass the gates. No real model has been run for this repository yet.

## Keys

`key = sha256(task + "\n" + canonicalJson(keyInput))`, where `keyInput` is the task input without `image.bytesBase64` (the image
hash and type stay). `canonicalJson` sorts keys recursively. Every field of the input comes from the source files, never from the
live DOM (the page title from the source `<title>` or `h1`, the surrounding text from the mapped element's parent, the image
bytes from disk through `readInsideRoot`), so the key is the same in recorded and browser mode. The demo test compares the keys
logged by both modes.

## Fixture format

`fixtures/llm/storefront.json` (`schemaVersion: 1`) holds `promptHashes` (`sha256` of the prompt's name and system text) and
`responses`, each `{ key, task, label, input, attempt, output }`. A response matches on `(key, attempt)`. Attempt 2 is looked up
only after attempt 1 was rejected, by a value gate or by the acceptance gate; the feedback text is part of the second prompt but not
of the key, so the fixture does not depend on its wording. `error` responses (`timeout`, `server_error`, `invalid_json`) count as
failed attempts. `fixtures/llm/README.md` explains each answer. `npm run fixtures:rekey` recomputes keys and prompt hashes, and the
Git diff is the review.

## Scenarios

| Scenario | File | What it proves |
|---|---|---|
| `storefront` | `fixtures/llm/storefront.json` | The demo: 10 calls; a filename `alt` rejected by a value gate then a good one; the promo-link name "Shop deals" passes every value gate and is rejected by the browser re-audit, then "Sale: shop deals" is accepted; a `decorative` verdict becomes a suggestion |
| `adversarial` | `tests/fixtures/llm/adversarial.json` | Every gate reason: markup, URL, 300 characters, "image of", adjacent text, generic names, decorative inside a link, an output that fails Zod |
| `missing-key` | `tests/fixtures/llm/missing-key.json` | Strict error and lenient suggestion |
| `unavailable` | `tests/fixtures/llm/unavailable.json` | `timeout` then `server_error`: `LLM_UNAVAILABLE`, the report is still written, exit 5 |

The LLM answers in the README, the report and the media are scripted answers from this provider. They say nothing about how well a
real model performs; see `docs/eval.md`.
