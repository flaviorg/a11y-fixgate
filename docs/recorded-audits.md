# Recorded audits

Unit tests and the offline demo never start a browser. They replay audit snapshots that a real Chromium
produced earlier and that live in `tests/fixtures/audits/<scenario>.<key12>.json`.

## Keys

Each file holds `{ recordingKey, label, snapshot }`. The key is

```
recordingKey = sha256(treeSha256(servedRoot) + "\n" + sortedWatchKeys.join(","))
```

- `treeSha256` hashes every regular file the static server serves (HTML, CSS, JS, images), so a change to
  any served byte, not only the HTML, gives a new key.
- The watch list holds the DOM node keys (`<tag>[<domTagIndex>]`) whose aria snapshot an audit must capture.
  The same tree audited with a different watch list is a different recording.
- `<key12>` in the file name is the first 12 hex characters of the key.

The recorded runner (`src/infra/recorded-runner.ts`) validates every file against the strict snapshot schema
when it loads them. A miss fails with `NO_RECORDING`, naming the first 12 characters of the tree hash and the
page path. A recording also has to match the page path it is asked for.

Before writing, `fixtures:record` strips run-to-run variance: `screenshots.fullPage` becomes `""`, the three
timings become 0 and the URL becomes `http://127.0.0.1:0<pagePath>`. The recorded runner puts the live URL
back when it replays a snapshot.

## When to re-record

Run `npm run fixtures:record` (it needs a browser, see `A11Y_BROWSER_PATH`) after any change to:

- `fixtures/storefront/**`,
- a fixer,
- `src/browser/page-scripts.ts` or the Playwright runner,
- the LLM fixture.

The script rewrites the directory and prints `new`, `same` or `gone` for each key.

## Checking without a browser

`npm run fixtures:record -- --check` replays every scenario with the recorded runner. For each key the
pipeline needs it prints `ok <key12> <scenario> <label>` or `missing <key12> <scenario> <label>`. On a missing
key the baseline snapshot stands in so the run can continue, and the script says that the keys after the
first missing one are provisional. It exits 1 if any key is missing.

## Scenarios and labels

Each scenario runs the whole pipeline (`runAudit`): the baseline, one audit per verified candidate and the
combined audit. Every snapshot is saved under its key with a label: `baseline`,
`<findingId>/<strategy>/a<attempt>` (for example `label-2/label-fresh-id/a1`) or `combined`. The labels
come from the run's outcomes: each accepted or rejected outcome is one audited candidate, in loop order.
Both modes print each scenario's `formatSummary` to stderr.

Each scenario's LLM provider is built from its config with the same factory the CLI uses
(`createLlmProvider`, then `strategyRunnerFor`: `none` needs no runner).

| Scenario | Source | LLM | Audits |
|---|---|---|---|
| `storefront-none` | `fixtures/storefront`, `--lang en` | none | 7: the baseline, 5 candidates, the combined audit |
| `storefront` | `fixtures/storefront`, `--lang en` | strict fake, `fixtures/llm/storefront.json` | 15: the baseline, 13 candidates, the combined audit (10 LLM calls) |
| `storefront-write` | a temporary copy of `fixtures/storefront`, `--lang en`, `--write` | strict fake, `fixtures/llm/storefront.json` | 16: the 15 of `storefront` plus `write-subset`, the audit of the verified fixes only (the 3 of rows 1, 2 and 8), watching `html[0]` and `input[1]` |
| `uncovered` | `tests/fixtures/sites/uncovered` | lenient fake, the storefront fixture | 1: the baseline (both LLM strategies end as `no-scripted-answer`, so nothing is audited after it) |

The scenarios run in that order, and a key that an earlier scenario already recorded keeps its file. The
baseline and the five deterministic candidates are the same trees in `storefront-none` and `storefront`, so
they are stored once, under `storefront-none.*`. The directory holds 18 files: 7 `storefront-none`, 9
`storefront` (the 8 LLM candidates and the combined audit), 1 `storefront-write` (`write-subset`) and 1
`uncovered`.

`storefront-write` is the `--write` run of P-7. It is a scenario of its own, not a second run inside
`storefront`, because `storefront` must stay a run without `--write`: the report and SARIF tests read its
result, and `remainingInSource` there is the baseline. Its copy of the fixture has the same tree hash as the
fixture itself (paths are relative to the root), so every recording is shared; only `write-subset` is new.
The label `write-subset` comes from `AuditRun.writeSubsetAudited`. `cli.e2e` replays it with
`--write` over a temporary copy of the storefront.

## The demo

`npm run demo` (no flags) replays the 15 audits of the `storefront` scenario from this directory, so it needs no browser and finishes in about 0.1 s of audit time. `npm run demo -- --browser` runs the same
pipeline in a real Chromium; `tests/e2e/demo.e2e.test.ts` asserts that both modes log the same LLM keys. After any change that needs `npm run fixtures:record`, record again and re-run the demo in both modes
before pasting its output into `docs/demo-output.md` and the README.
