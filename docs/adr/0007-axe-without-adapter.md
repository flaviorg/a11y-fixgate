# 0007. axe is injected with `page.evaluate`, with no adapter package

- **Status:** accepted (2026-10-12, decision D-24).

## Context

`@axe-core/playwright` bundles its own axe-core version. Measured on 2026-10-08, `new AxeBuilder({ page })` reported engine 4.13.0 while the project installed 4.14.0, and the
builder's option order silently dropped `runOnly` when `withTags` came before `options`. Separately, `page.addScriptTag({ content: axe.source })` throws under a
Content-Security-Policy that forbids inline scripts, and the report itself ships such a policy; `page.evaluate(axe.source)` is not blocked (verified 2026-10-12).

## Decision

The runner injects the source of the installed `axe-core` with `page.evaluate(axe.source)` and calls `axe.run` with a tag-type `runOnly` of the six WCAG tags, in
the page. There is no adapter. `src/browser/axe-config.ts` is the only run-time importer of `axe-core`. If the engine that answers is not the installed one, the
run fails with `AXE_VERSION_MISMATCH`. `bypassCSP: true` was not used because it changes how the audited page behaves.

## Consequences

- One engine version exists by construction, and the recordings assert `axeVersion` equal to the installed one.
- The audited page's CSP cannot stop the audit, and the report passes the tool's own audit despite its strict CSP (`tests/e2e/report-self-audit.e2e.test.ts`).
- axe runs in the main frame only, so iframe content is not audited (`docs/coverage.md`); the adapter's per-frame handling is not available.
- Five runtime dependencies instead of six.
- The runner owns timeouts, node descriptors and the result shape that the adapter would have provided.

## Alternatives

- `@axe-core/playwright` with `axeSource`: works, but keeps a second engine in `node_modules` and the option-order trap.
- `addScriptTag`: blocked by CSP.
- `bypassCSP: true`: changes the page under audit.
