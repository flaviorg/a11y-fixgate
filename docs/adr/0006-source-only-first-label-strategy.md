# 0006. The first `label` strategy reasons over source only, on purpose

- **Status:** accepted (2026-10-12; decisions D-02 and D-25 of the design).

## Context

An unlabeled `<input>` next to a `<label>` is the most common form failure after contrast. The obvious fix gives the input an `id` and the label a matching
`for`. A static tool or a codemod can only see source files, where the id `email` is free. At run time the fixture's `newsletter.js` injects another
`#email`, so the obvious fix creates a duplicate id, which axe reports as `duplicate-id-aria` in `incomplete`.

## Decision

The catalog for `label` has two deterministic strategies in this order.

1. `label-associate` is source-only: the id comes from the input's `name` (or `field-<n>`) and is unique in the file. It does not read the live DOM. It
   represents what a static fixer would do, and it exists so that the verification loop has something real to catch.
2. `label-fresh-id` consults `domIds` and the run-level `IdAllocator`, so it allocates `email-2`.

Both share the adjacency precondition. A third strategy, `aria-label-llm`, covers an input with no usable label.

## Consequences

- On the fixture, strategy 1 is rejected with `new-incomplete: duplicate-id-aria` and strategy 2 is accepted. Together with the promo-link case this shows the gate
  is not a formality: it rejects a model's proposal and code's proposal alike.
- It looks staged if presented as the lead example. The README therefore leads with the LLM rejection and shows this one second, labelled as what a static
  fixer would have done.
- The cost is one extra browser audit for each label the first strategy gets wrong.
- On a site without a colliding id strategy 1 is accepted, and strategy 2 never runs.

## Alternatives

- Only the DOM-aware strategy: it never fails, so the fixture would show one rejection only.
- A second `duplicate-id-aria` rejection built by hand: the real case is better evidence.
