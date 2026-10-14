# 0002. Findings are identified by a source-anchor fingerprint, not a selector

- **Status:** accepted (2026-10-08, decision D-02).

## Context

The acceptance gate compares the findings before and after a fix. If a finding's identity is its CSS selector, a fix can make the same element look
new. Measured on 2026-10-08: the email input is `#email` in the baseline and `input[aria-label="Newsletter email"]` after an `aria-label` fix. Compared by
selector, the fixed element would appear as both a fixed finding and a new one.

## Decision

`fingerprint = fnv1a64("v1|" + ruleId + "|" + anchor)`. The anchor is `src:<file>#<tag>[<ordinal>]` for a mapped node, and the start-tag signature (tag plus
sorted attributes, descendants excluded) for an unmapped one. The status (`violation` or `incomplete`) only chooses the bucket and is never hashed, so a rule
that moves between buckets keeps its identity. A selector is never part of it. The hash is a pure FNV-1a in `src/domain/hash.ts`, which keeps `node:crypto` out of
the domain layer. One definition serves findings, finding sets, SARIF `partialFingerprints` and the gate's target.

## Consequences

- A fix that adds an attribute does not change the element's identity: `tests/unit/fingerprint.unit.test.ts` covers the same anchor with different selectors
  and an unmapped ancestor whose child changes.
- The anchor is stable only while fixers do not insert elements of the fixed tag. A future fixer that does (a wrapper, say) needs an anchor by parent path
  plus ordinal; the only inserted element in v1 is `<title>`, a tag no finding is anchored on.
- Because the same rule on the same element in `incomplete` and `violations` hashes alike, the gate can detect a violation that was downgraded to a
  needs-review item (ADR 0004).
- The SARIF fingerprint is stable between runs, so code scanning can match alerts through its normal mechanism.

## Alternatives

- The CSS selector: drifts, as measured.
- A hash of the element's text: changes with the fix and collides for repeated elements.
- `status` inside the hash: a downgrade would look like a fixed finding plus a new one.
