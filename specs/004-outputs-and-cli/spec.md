# Outputs, CLI and repository

## Context

The outputs are an escaped HTML report with a strict Content-Security-Policy that passes the tool's own audit,
`fixes.patch` (one diff per file, repository-root-relative `a/` and `b/` names), `results.sarif` (SARIF 2.1.0 subset,
only findings that are still in the files) and `audit.json`. `--write` writes only fixes with status `verified`. The
CLI is `node src/cli.ts audit`, with exit codes 0 to 5, `--fail-on` evaluated on the source files, redaction on every
write and signal handling. `npm run demo` runs the storefront through the same pipeline and prints the layout of
spec 10.2. The repository itself is part of this feature: specs, `AGENTS.md`, hook, CI, secrets scan and the README
rules are checked by tests.

## Acceptance criteria

- **OUT-01** The report shall contain the summary with the two verification statuses and the needs-review count, one card per outcome with the screen reader view diff, the page screenshots before and after when available, the diff, strategy kind, verdict with reasons, the suggestions, the unmapped list, the methodology and the standards note; and when audited by the tool it shall produce 0 violations and 0 keyboard findings.
- **OUT-02** `fixes.patch` shall contain one unified diff per touched file, from the baseline to the combined content of the accepted non-conflicting candidates, each applying strictly to its original file.
- **OUT-03** `results.sarif` shall be SARIF 2.1.0 with one run, results only for mapped findings present in the files (the `remainingInSource` set), `uri` relative to the SARIF root (repository root), required `physicalLocation` fields with 1-based lines and columns, `partialFingerprints`, level mapping per section 5.8.1 with every `incomplete` finding as `note`, `fixStatus` per result, at most 1,000 results and 10 tags per rule.
- **OUT-04** `audit.json` shall validate against the result schema, use stable key order, and contain no absolute path and no secret.
- **OUT-05** When `--write` is given and the audit of the tree to be written agrees, the system shall write only the touched files inside the source root, limited to fixes with status `verified` (never a fix flagged `needsHumanReview`), refusing symbolic links, and the written files shall equal the audited tree, which shall contain none of the written fingerprints.
- **OUT-06** Every finding shall carry an impact entry per persona from the catalog, rendered without the LLM, and every catalog entry shall cite the WCAG 2.2 Understanding page of its criterion.
- **OUT-07** Every value interpolated into the report shall pass through `escapeHtml`, and the report shall carry a Content-Security-Policy meta tag with no script source, so that page content and model output can never execute when the report is opened.
- **CLI-01** The CLI shall exit 0 on completion, 1 on `--fail-on` or `COMBINED_MISMATCH`, 2 on usage or config errors, 3 without a browser, 4 on audit infrastructure errors, 5 when the LLM provider (any provider) was unavailable for a needed strategy.
- **CLI-02** When `--fail-on <impact>` is given, the CLI shall exit 1 only if a finding present in the source files (the baseline, or the audit of the written tree when `--write` wrote) has an impact at or above that level; an accepted fix that was not written, including every fix flagged `needsHumanReview`, shall not lower the exit code.
- **CLI-03** The built-in static server shall serve `--src` on `127.0.0.1` with an ephemeral port, refusing paths that resolve outside the root's realpath, and `npm run demo` shall complete in recorded mode without a browser.
- **CLI-04** Every string written to stdout, stderr, the report, SARIF and JSON shall pass through redaction.
- **CLI-05** When the CLI is run as `node <tool>/src/cli.ts` from a working directory outside the tool, it shall resolve the default fake fixture relative to the tool's directory, resolve `--src` against the working directory, and, on a site the fixture does not cover, exit 0 with SARIF `uri` values relative to `--repo-root`.
- **REP-01** `AGENTS.md` shall have at most 100 lines.
- **REP-02** `.env.example` shall list every variable read by the config schema.
- **REP-03** If any test attempts a connection outside loopback, the connection shall fail with the guard error.
- **REP-04** The pre-commit hook shall exist, be executable, and run typecheck, unit tests and `check:secrets`.
- **REP-05** The dependency rules of section 4.3 shall hold for every file under `src/`.
- **REP-06** Every EARS ID in `specs/*/spec.md` shall appear as `[ID]` in a test name or in the allowlisted file.
- **REP-07** No versioned file outside the excluded paths of section 8.2 shall contain `TODO`, `TBD` or a key-shaped string, and `README.md` shall contain no phrase from the forbidden list of Appendix B.
- **REP-08** `ci.yml` shall install the browser with `npm run browser:install`, set `REQUIRE_BROWSER=1`, and use `actions/checkout@v7` and `actions/setup-node@v7` with `node-version-file: .nvmrc`.

## Non-goals

- A SARIF schema validator dependency: the emitted subset is small; a Zod schema of the subset and the GitHub limits are tested.
- Legal advice or compliance claims: the wording is fixed ("not a conformance audit and not legal advice") and the
  forbidden phrases are enforced on `README.md`.
- Modifying or bundling axe-core: it is used unmodified from `node_modules` (`NOTICE`).
- One-command install, `npx` and a `bin` field: Node 24 refuses type stripping under `node_modules`; v1 is clone and run.
- A composite GitHub Action, `--write-llm` and `--url` mode (M10).
- Windows CI (Ubuntu only) and a coverage gate (the coverage report is published without a minimum).
- Writing patches for generated sites: patches apply to the files `--src` points at.

## Questions resolved

**Plan decisions**

- P-2: `--fail-on` evaluates only findings with status `violation` that are still in the source files; needs-review
  items never fail a build.
- P-6: `TOOL` in `src/contracts/tool.ts` holds the name (`a11y-fixgate`, decided on 2026-10-14, D-19), version and information URI.
- P-7, P-8: recording files are `tests/fixtures/audits/<scenario>.<key12>.json`; `storefront-write` is a scenario of
  its own so that `storefront` stays a run without `--write`; `--check` prints `ok` or `missing` per key.
- P-11: with zero included fixes no `fixes.patch` is written and the summary says `No fixes to apply`.
- P-17: `write.e2e` runs `git apply --check` in a temporary directory without `git init`, with `GIT_CEILING_DIRECTORIES` set.
- P-18: `demo.gif` is rendered by `scripts/capture-media.ts` from the captured stdout of a real run; the caption says so.

**Behaviour the spec left open**

- `AuditResult.written` holds the files written, the finding ids they fix and the findings of the audit of the written
  tree; `audit.json` is the result plus `schemaVersion: 1`, with a public config (relative paths, no executable path,
  `apiKey` shown as `[REDACTED]`).
- After `--write` the patch is generated from the written content, so `git apply fixes.patch` still works for the
  fixes that were left out. A combined-audit mismatch writes `fixes.rejected.patch`, the report and SARIF, and exits 1.
- SARIF: `properties.repoRoot` is the directory name only; rule tags are `accessibility`, `wcag2.2`, `wcag-<criterion>`;
  `fixStatus` precedence is accepted, conflict, suggest-only, rejected, skipped, none; a file outside the repository
  root gets the `--src`-relative name with `uriOutsideRoot`.
- Report: one block per finding with one card per outcome, each scrollable `<pre>` is `role="group"` with `tabindex="0"`
  and an `aria-label`, and redaction runs before escaping (a redaction marker contains `<` and `>`).
- CLI: a malformed flag value is `USAGE`; a value the schema rejects is `CONFIG_INVALID` naming the flag or variable,
  never the value. `COMBINED_MISMATCH` and `--fail-on` (1) win over `LLM_UNAVAILABLE` (5). `--no-fix` gives no outcomes.
- Demo: `npm run demo` ignores `LLM_PROVIDER`, accepts `--browser` and `--out <dir>`, and logs the key of every LLM
  call at `info` on stderr. Its totals line splits the needs-review count by reason ("7 LLM + 1 design review").

**Fixture and count notes**

- Every output carries the inventory of spec 5.15: SARIF has 18 results with 11 `accepted`; the summary reads
  `Accepted 11 (verified 3, needs human review 8) | rejected 2 | gate-rejected 1 | suggest-only 6 | unmapped 1`; after
  `--write` on a copy 3 verified fixes are written and 16 of the 19 findings remain in the source.
- The illustrative elapsed time of spec 10.2 (24.9 s) is not a count: a real browser run of the demo takes about 3 s here.

## Checklist

Test file per criterion. A criterion is covered when its ID starts a test name (`[ID]`) in the file.

| Criterion | Test file |
|---|---|
| OUT-01 | `tests/e2e/report-self-audit.e2e.test.ts`, `tests/unit/report-html.unit.test.ts`, `tests/unit/write-outputs.unit.test.ts` |
| OUT-02 | `tests/e2e/write.e2e.test.ts`, `tests/unit/bounded-patch.unit.test.ts`, `tests/unit/write-outputs.unit.test.ts` |
| OUT-03 | `tests/unit/contracts.unit.test.ts`, `tests/unit/sarif.unit.test.ts`, `tests/unit/write-outputs.unit.test.ts` |
| OUT-04 | `tests/unit/audit-json.unit.test.ts`, `tests/unit/contracts.unit.test.ts`, `tests/unit/write-outputs.unit.test.ts` |
| OUT-05 | `tests/e2e/write.e2e.test.ts`, `tests/unit/bounded-patch.unit.test.ts`, `tests/unit/run-audit.unit.test.ts` |
| OUT-06 | `tests/unit/personas.unit.test.ts` |
| OUT-07 | `tests/unit/report-html.unit.test.ts` |
| CLI-01 | `tests/e2e/cli.e2e.test.ts`, `tests/unit/cli-args.unit.test.ts`, `tests/unit/fake-provider.unit.test.ts`, `tests/unit/llm-strategies.unit.test.ts`, `tests/unit/redact.unit.test.ts` |
| CLI-02 | `tests/e2e/cli.e2e.test.ts`, `tests/unit/cli-args.unit.test.ts`, `tests/unit/run-audit.unit.test.ts` |
| CLI-03 | `tests/e2e/demo.e2e.test.ts`, `tests/unit/static-server.unit.test.ts` |
| CLI-04 | `tests/e2e/cli.e2e.test.ts`, `tests/unit/redact.unit.test.ts` |
| CLI-05 | `tests/e2e/cli.e2e.test.ts`, `tests/unit/cli-args.unit.test.ts` |
| REP-01 | `tests/repo/conventions.unit.test.ts` |
| REP-02 | `tests/repo/conventions.unit.test.ts`, `tests/unit/contracts.unit.test.ts` |
| REP-03 | `tests/repo/no-network.unit.test.ts` |
| REP-04 | `.githooks/pre-commit`, `tests/repo/conventions.unit.test.ts` |
| REP-05 | `tests/repo/conventions.unit.test.ts` |
| REP-06 | `tests/repo/conventions.unit.test.ts` |
| REP-07 | `tests/repo/check-secrets.unit.test.ts`, `tests/repo/conventions.unit.test.ts` |
| REP-08 | `tests/repo/ci-workflow.unit.test.ts` |
