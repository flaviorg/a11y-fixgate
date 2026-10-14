# Scripted LLM answers

`storefront.json` holds the answers of the fake provider for the demo page `fixtures/storefront/index.html` (spec 7.2 and 7.3). The demo, the tests and `npm run fixtures:record` use it with the strict fake; the CLI uses it with the lenient fake when no provider is configured.

Each response is matched on `(key, attempt)`. The key is `sha256(task + "\n" + canonicalJson(input))`, where the input has `image.bytesBase64` removed (the image `sha256`, `mime` and `bytes` stay). Every input field comes from the source files (the parent element's text, the source `<title>` or `<h1>`, the image bytes on disk), so the keys are the same with the recorded runner and with a real browser.

| Input | Attempt 1 | Attempt 2 |
|---|---|---|
| hero image | informative, "Orbit Outfitters autumn collection banner" | |
| jacket image, card 1 | "jacket.png" (the value gate rejects it: `alt-is-filename`) | "Green waterproof trail jacket with hood" |
| jacket image, card 2 | "Green trail jacket, kids size" | |
| divider image | decorative, `alt: ""`, "visual separator" (a suggestion for a human) | |
| logo link | "Orbit Outfitters home" | |
| promo link | "Shop deals" (the browser re-audit rejects it: `label-content-name-mismatch`) | "Sale: shop deals" |
| search textbox | "Search products" | |
| cart button | "Open cart" | |

That is 10 calls in one demo run.

## Changing an answer or a prompt

1. Print the inputs the run builds: `node scripts/rekey-fixtures.ts --print-inputs` (needs the recorded storefront baseline).
2. Edit the `input` and `output` of the response.
3. Run `npm run fixtures:rekey`. It recomputes every `key` from the stored `input` and every `promptHashes` entry from the current prompts, and prints the changes. The Git diff is the review.
4. Run `npm run fixtures:record` (needs a browser) and `npm run fixtures:record -- --check`.

A prompt change (its name or system text) changes its hash. The fake refuses a fixture whose hash differs (`FIXTURE_PROMPT_DRIFT`) until it is rekeyed.

The test fixtures live in `tests/fixtures/llm`: `adversarial.json` (every value-gate reason), `missing-key.json` (no responses) and `unavailable.json` (a timeout, then a server error, for every storefront input).
