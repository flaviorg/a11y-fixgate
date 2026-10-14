# 0004. A violation that moves to "needs review" after a fix is rejected

- **Status:** accepted (2026-10-08, decision D-01).

## Context

axe reports three buckets: violations, passes and `incomplete` ("needs review", where it cannot decide). A fix can make a target violation disappear by
pushing it, or a neighbour, into `incomplete`. Measured on 2026-10-08: adding `id="email"` to the signup input while another input already has that id makes
the `label` violation vanish and puts `duplicate-id-aria` in `incomplete`. A gate that only counts violations would call that a success.

## Decision

`judge(baseline, after, target)` accepts only when the target fingerprint is absent from both buckets, no violation fingerprint is new, no keyboard fingerprint
is new, no baseline violation has moved to `incomplete`, and no `incomplete` fingerprint is new. The reasons are `target-still-present`, `new-violation`,
`new-incomplete`, `violation-downgraded` and `new-keyboard-finding`. `--allow-new-incomplete` relaxes only brand-new needs-review items (they become
warnings); a downgraded violation is rejected with or without it.

## Consequences

- This is what rejects `label-associate` on the fixture's email field (`duplicate-id-aria`), the second headline rejection.
- "Verified" means no new axe or keyboard finding of any bucket, which is stricter than "fewer violations". It still does not see layout, script
  errors or meaning, and the README says "no new detectable failure".
- Flaky `incomplete` results unrelated to a fix could reject good fixes on real sites. The default stays; the flag exists for that case.

## Alternatives

- Count violations only: accepts the duplicate id.
- Warn instead of reject: a warning after an automatic fix is a finding the user must triage, which is the problem the tool is meant to remove.
