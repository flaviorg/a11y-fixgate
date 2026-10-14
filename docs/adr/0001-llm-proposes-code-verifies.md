# 0001. The LLM proposes, code verifies

- **Status:** accepted (2026-10-08, decision D-03 of the design).

## Context

An accessibility tool that asks a model to "fix the page" returns text nobody can check. Models write plausible alt texts and names, and
sometimes a plausible one is wrong in a way a machine can catch (a link name that hides its visible text) or cannot (a description that is
simply inaccurate). The project's claim is that fixes are verified, so the verification has to be something other than the model's word.

## Decision

The work is split along what can be checked.

| Deterministic code decides, verifies, measures | The LLM proposes, classifies the ambiguous |
|---|---|
| axe-core execution, the rule set, the tags | alt text for an image |
| keyboard traversal and its three checks | the accessible name of an icon-only control or an unlabeled input |
| DOM node to source offset mapping (parse5-confirmed) | whether an image is decorative (never applied, only suggested) |
| every mechanical fix, the bounded diff, the acceptance gate, fingerprints, SARIF, exit codes | |

The model returns a value, never a diff. Code builds the edit, a bounds gate checks it, the browser re-audits it, and a pure gate decides. Where the
value itself is what must be right, the tool says so: the browser proves presence, a human confirms meaning. Every LLM-derived value is flagged
"needs human review" and is not written by `--write` in v1.

## Consequences

- `src/domain` cannot import `src/llm` (a dependency test enforces it), so no gate can depend on a model.
- The whole loop runs offline against a scripted fake keyed by a hash of the input (`docs/fake-provider.md`).
- The tool never claims that LLM text is correct, and LLM quality stays unmeasured until the evaluation of `docs/eval.md` runs.
- A fix needs a real browser re-audit per candidate, which is the cost of the claim.

## Alternatives

- The model emits a unified diff: rejected, see ADR 0003.
- The model also judges whether its own fix worked: rejected, the judge would share the proposer's blind spots.
- Report only, no fixes: the many tools that already do that are the reason this one exists.
