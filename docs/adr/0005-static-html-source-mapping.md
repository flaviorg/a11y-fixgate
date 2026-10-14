# 0005. Source mapping: attribute, then ordinal, then unique signature, on static HTML only

- **Status:** accepted (2026-10-08, decision D-06).

## Context

A fix is an edit to a file, so a finding in the DOM must be tied to an exact element in a file. The DOM of a framework app does not exist verbatim in source.
Scripts also add or remove nodes, which breaks naive positional matching: the fixture's newsletter script injects an `<input>` and a `<button>`.

## Decision

The page file is parsed with parse5 and `sourceCodeLocationInfo`. A node maps by, in order:

1. `data-a11y-source="file:line:col"`, when an element of the same tag starts there (`attribute`);
2. tag ordinal, when the DOM count of the tag equals the source count and the attribute signature matches (`ordinal`);
3. a signature (tag, attributes, and text when the node has any) shared by exactly one source element (`signature`).

Zero candidates is `Unmapped("no-candidate")`, two or more is `ambiguous`, and the tool never picks the closest. Targets inside shadow roots or iframes are `dom-only`.
Unmapped means no patch. v1 maps static HTML only.

## Consequences

- On the fixture, 18 of 19 findings map (ordinal 12, signature 6); the injected input is `no-candidate`, which is correct.
- Ordinal fails page-wide for a tag a script injects (`input`, `button`), and the signature step takes over. This is why a signature, not a position, is the fallback.
- A generated site is audited on its authored HTML, or the build emits `data-a11y-source` (`docs/architecture.md`).
- JSX, Vue and Svelte are out of scope; a Babel-based mapper is a known path, not a promise.

## Alternatives

- Search only (no ordinal): ambiguous for identical elements, such as the fixture's two jacket images.
- Closest match: fixes the wrong element silently.
- Build-time instrumentation only: needs every user to change their build before a first try.
