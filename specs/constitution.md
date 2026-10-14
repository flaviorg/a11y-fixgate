# Constitution

The rules every spec, test and change in this repository answers to. A rule here wins over a convenience.

1. **The LLM proposes, code decides.** A model returns a value (an `alt` text or an accessible name), never a diff.
   Deterministic code builds every patch, runs every gate and makes every decision. The dependency rules keep
   `src/domain` from importing `src/llm`.
2. **"Verified" has one meaning.** The fix was applied to a scratch copy, the page was served and audited again in
   a real browser, the target finding is gone, and no new axe or keyboard finding appeared, not even a needs-review
   item. It does not see layout, script errors or meaning.
3. **Needs-review fixes are never written in v1.** Every LLM-derived value, every contrast change and every inferred
   `lang` is flagged `needsHumanReview`. `--write` writes only fixes with status `verified`. A `decorative` verdict
   is never applied. Keyboard findings are reported, never fixed.
4. **The files decide the exit code.** `--fail-on` looks at what is in the source tree, never at what a patch could
   do. A fix that exists only in `fixes.patch` does not lower it.
5. **No network in tests.** `npm test` loads the no-network guard. Only loopback is reachable. Tests never read a
   real key, and child processes get an explicit minimal environment.
6. **Exact versions.** Five runtime dependencies, two dev dependencies, all pinned, with a committed lockfile. No
   `bin` field and no publish step in v1.
7. **Every acceptance criterion has a test.** Criteria are EARS sentences with an ID, and the ID is the start of the
   test name: `test("[VER-02] ...")`. Tests assert on structure, enums, numbers and stable reason strings, never on
   free LLM text. The test comes before the code.
8. **Counts come from the fixture inventory.** `fixtures/storefront` is written from one table (spec 5.15). If a real
   browser disagrees, the fixture changes first; a count changes only when the fixture cannot express the row, and
   the change is written down in the feature spec.
9. **Everything that leaves the process is redacted.** Stdout, stderr, the report, SARIF and JSON go through
   `redactSecrets`. Key-shaped test values are built at run time.
10. **Honest claims.** The README states what the tool does not see, that LLM proposal quality is not measured, and
    which WCAG 2.2 AA criteria it does not check. The forbidden phrases of the standards note are enforced by a test.
11. **English everywhere.** Code, comments, tests, CLI output and docs. Course material is never copied into the
    repository.
12. **Nothing is published without the owner.** No commit, push, release, remote repository or Pages site is created
    by an agent. The owner validates first.
