# AGENTS.md

Facts for anyone (human or agent) changing this repository. The rules behind them are in `specs/constitution.md`.

## What it is

An LLM-assisted accessibility fixer with a deterministic verification loop. It audits one static page for WCAG 2.2 AA
(axe-core plus three keyboard checks) in a real Chromium, maps findings to source offsets, builds bounded patches
from deterministic fixers or LLM-proposed values, re-audits every candidate in a scratch copy, and lets a pure
acceptance gate decide. Name: `a11y-fixgate`, decided on 2026-10-14 (D-19; one constant, `TOOL` in `src/contracts/tool.ts`).

## Commands

- `npm ci`, then `npm run browser:install` once (Playwright's pinned Chromium; CI does this).
- `npm run typecheck` (`tsc --noEmit`, TypeScript 7 is used for nothing else).
- `npm test` (unit, repo and e2e), `npm run test:unit` (no browser), `npm run test:coverage`.
- `npm run demo` replays the recorded audits (no browser, no key, under 10 s). `npm run demo -- --browser` runs them
  in a real Chromium.
- `npm run audit -- --src <abs path> --repo-root <abs path> --lang en --out <abs path>` audits a site.
- `npm run fixtures:record` (needs a browser), then `npm run fixtures:record -- --check`.
- `npm run check:secrets`. `npm run setup:hooks` enables `.githooks/pre-commit`.
- Local browser: set `A11Y_BROWSER_PATH` to a Chromium executable and run `REQUIRE_BROWSER=1 npm test`, so browser
  tests fail instead of skipping.

## Layers (checked by `tests/repo/conventions.unit.test.ts`)

- `src/contracts` (Zod) and `src/domain` (pure: mapping, fixers, gates, fingerprints, acceptance gate, combine)
  import no `node:*`, `playwright-core`, runtime `axe-core`, or any other layer.
- Only `src/browser/**` imports `playwright-core`. Only `src/browser/axe-config.ts` imports `axe-core` at run time.
- Only `src/llm/openai-compatible.ts` calls `fetch`. Only `src/cli.ts`, `scripts/*.ts` and `tests/**` read `process.env`.
- `src/**` has no `console.log`, `console.info` or `console.debug`. Stdout is written through `writeOut()`
  (`src/infra/write-out.ts`, redacting), called only by `src/cli.ts`, `scripts/demo.ts` and `scripts/check-secrets.ts`.
- `src/infra` holds the filesystem, server, recordings and logging. `src/app` sequences the loop. `src/output` renders.
- Erasable TypeScript only: no `enum`, `namespace`, parameter properties or decorators. Relative imports end in `.ts`,
  types use `import type`, Zod is imported as `import * as z from "zod"`.

## Working rules

- TDD with EARS IDs: write the failing test first, and start its name with the criterion in brackets, `[VER-02]`.
  Criteria without an ID use `[CS-n]`, `[RF-n]` or `[P-n]`.
- No network in tests. Never put a real key in a file; build key-shaped test values at run time.
- After changing the fixture, a fixer, `page-scripts.ts`, the runner or the LLM fixture, run `npm run fixtures:record`,
  then `npm run fixtures:record -- --check`, which must print no `missing` line.
- `fixtures/storefront` is the source of every count (spec 5.15). Change the fixture before changing a count.
- Exactly five runtime dependencies at exact versions. Do not add `@axe-core/playwright`, an LLM SDK, an image
  library, a YAML parser or a DOM library.
- Mermaid: quote every flowchart node label, keep `/` and `(` out of sequence-diagram aliases, and validate each
  diagram with `npx -y @mermaid-js/mermaid-cli`.
- Everything is in English. Never copy course material into the repository.
- Nothing is committed, pushed or published without the owner's validation.

## Where things are

- `specs/` holds the constitution and four feature specs with the EARS criteria and a checklist of the tests.
- `docs/architecture.md` has the components, the loop, the fingerprint and the combine rule. `docs/adr/` has the decisions.
- `docs/threat-model.md` maps every control to the test that proves it. `docs/coverage.md` lists what is and is not checked.
- `docs/recorded-audits.md` explains the recordings. `docs/api-notes.md` records the library behaviour checked on this machine.
