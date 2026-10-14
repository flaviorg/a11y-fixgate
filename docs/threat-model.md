# Threat model

The tool reads code it does not trust, runs it in a browser, talks to a model it does not control, and writes files. This page lists who could
abuse that, what they could reach, and which test proves each control.

## Adversaries

1. **The author of the audited page.** Markup, scripts, CSS and image files in `--src` are attacker-controlled when the tool runs on a
   stranger's site or a pull request.
2. **The LLM provider and its output.** A model can return markup, URLs, very long text, instructions or invalid JSON, and the provider
   sees whatever is sent to it.
3. **Content that carries instructions.** Page text or an image that says "ignore the above and ..." (prompt injection).

## Assets

- The operator's filesystem (files outside `--src`, and files inside it that must not be sent to a model).
- `LLM_API_KEY`.
- Local services reachable from the audit browser (loopback ports other than the tool's own server).
- The reviewer's browser, which opens `report.html`, a page built from untrusted strings.

## Controls and the tests that prove them

| # | Control | Test file and name |
|---|---|---|
| 1 | Every project file read for an LLM input or written by `--write` goes through `readInsideRoot`/`writeInsideRoot`: realpath containment, symlinks refused, size cap | `tests/unit/safe-read.unit.test.ts` "[VER-08] readInsideRoot refuses ../, absolute paths, backslashes, a symlinked file and a symlinked directory with UNSAFE_PATH" |
| 2 | An `<img src>` that leaves the root, or is a symlink, never reaches the model: `image: null` | `tests/unit/llm-strategies.unit.test.ts` "[VER-08] an image src of ../../outside.png, or a symlinked image, is refused and gives image: null without reading the target" |
| 3 | Only fixes with status `verified` are written; a symlinked or changed target refuses the write | `tests/e2e/write.e2e.test.ts` "[OUT-05] a symlinked target file is refused with UNSAFE_PATH and nothing is written"; `tests/unit/run-audit.unit.test.ts` "[OUT-05] a target that changed after the audit refuses the write, and a symlinked target is UNSAFE_PATH" |
| 4 | The static server serves only inside the root's realpath (no `..`, no symlink out) | `tests/unit/static-server.unit.test.ts` "[CLI-03] returns 404 for a missing file, for ../ escapes (raw request path via http.request) and for a symlink pointing outside the root" |
| 5 | The browser reaches only the exact origin of the tool's server: other HTTP origins, other loopback ports, WebSockets and service workers are blocked | `tests/e2e/audit-fixture.e2e.test.ts` "[AUD-08] only the server origin is reachable: ..." |
| 6 | axe is injected by evaluation, so a page's Content-Security-Policy cannot stop the audit | `tests/e2e/audit-fixture.e2e.test.ts` "[AUD-09] a page whose CSP forbids inline scripts is still audited" |
| 7 | LLM output is untrusted: Zod shape, then value gates (length, markup, URL, newline, file name, generic words, adjacent text) | `tests/unit/gates.unit.test.ts` "[LLM-03] the alt gate rejects ..." and "[LLM-04] the name gate rejects ..."; `tests/unit/llm-strategies.unit.test.ts` "[LLM-02] the adversarial fixture: two invalid proposals end as gate-rejected: llm-invalid ..." |
| 8 | Page content is wrapped in `<untrusted-content>` delimiters, with every `<` escaped so page text cannot close the tag. This bounds the shape of the output, not its meaning | `tests/unit/fake-provider.unit.test.ts` "[LLM-07] both prompts wrap page content in <untrusted-content> delimiters" |
| 9 | The model never writes a diff: a bounds gate checks every patch (one file, at most 3 ranges, attribute edits inside a start tag or one `<title>`, strict apply, patched text equals the edits) | `tests/unit/bounded-patch.unit.test.ts` "[FIX-08] four adversarial patches are rejected ..." |
| 10 | The report escapes every interpolated string and carries a Content-Security-Policy with no script source | `tests/unit/report-html.unit.test.ts` "[OUT-07] escapeHtml escapes the five characters, and html ...", "[OUT-07] a snippet ...", "[OUT-07] the CSP meta tag is present with no script source", "[OUT-07] [CS-6] the report head declares an inline icon that the CSP allows ..."; `tests/e2e/report-self-audit.e2e.test.ts` |
| 11 | The key is redacted from every string that leaves the process, and never appears in an output | `tests/unit/redact.unit.test.ts` "[CLI-04] redactSecrets masks apiKey, authorization and LLM_API_KEY at any depth"; `tests/e2e/cli.e2e.test.ts` "[CLI-04] with LLM_API_KEY set in the child env, the key appears in none of stdout, stderr, report.html, results.sarif or audit.json"; `tests/unit/audit-json.unit.test.ts` "[OUT-04] ..." |
| 12 | A bearer key never travels in clear text to a remote host: `LLM_BASE_URL` is https, or http on loopback only | `tests/unit/contracts.unit.test.ts` "[LLM-06] config accepts https and http on loopback, rejects http to a remote host, javascript: and file:" |
| 13 | Tests cannot reach the network, so a test can never leak a key or depend on a remote service | `tests/repo/no-network.unit.test.ts` "[REP-03] fetch to an external host fails with the guard error" and the two other cases |
| 14 | No key-shaped string is committed: `check:secrets` runs in the hook and in CI, and a test scans the tree | `tests/repo/check-secrets.unit.test.ts`, `tests/repo/conventions.unit.test.ts` "[REP-07] no versioned file outside the excluded paths contains a pending marker or a key-shaped string" |
| 15 | The run is bounded whatever the page does: caps on candidates, LLM calls and wall clock | `tests/unit/fix-loop.unit.test.ts` (caps) and `tests/e2e/cli.e2e.test.ts` |
| 16 | A fix that only looks right is rejected: the acceptance gate re-audits in a real browser and compares fingerprints | `tests/e2e/verify-loop.e2e.test.ts` (both headline rejections) |

## Not covered

- A malicious page that exploits a Chromium vulnerability. Run the tool on untrusted pages in a disposable environment (CI is one).
- What a real model does with an instruction hidden in an image: the fake never sees pixels, and the gates bound the shape of
  the answer only. `docs/eval.md` describes the injection items of the planned evaluation; no number exists yet.
- The contents of a remote model's logs. Alt-text and name proposals send the page title, the surrounding text and the image bytes
  of the mapped element to the configured provider. Do not use a real provider on a page you may not send out.
