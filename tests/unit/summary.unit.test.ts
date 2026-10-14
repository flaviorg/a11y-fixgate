// The human summary (spec 10.2; plan Task 34), over the recorded storefront run: layout, totals and the screen reader line.
import test from "node:test";
import assert from "node:assert/strict";
import { formatSummary } from "../../src/output/summary.ts";
import { emptyResult } from "../helpers/results.ts";
import { runAuditRecorded } from "../helpers/recorded.ts";

const options = { mode: "recorded", llmLabel: "fake, strict (fixtures/llm/storefront.json)" };

test("[CS-1] the totals line splits the needs-review count by reason and marks the retried gate rejection", async () => {
  const text = formatSummary(await runAuditRecorded("storefront"), options);
  assert.match(text, /^Accepted 11 \(verified 3, needs human review 8: 7 LLM \+ 1 design review\) \| rejected 2 \| gate-rejected 1 \(retried\) \| suggest-only 6 \| unmapped 1$/m);
  assert.match(text, /, 0 new$/m); // the combined audit introduced no finding of its own
});

test("[CS-1] the screen reader line shows the promo link before and after, and only for fixes that were rejected once", async () => {
  const lines = formatSummary(await runAuditRecorded("storefront"), options).split("\n").filter((l) => l.startsWith("Screen reader view"));
  assert.deepEqual(lines, ['Screen reader view, a.promo:  - link  ->  + link "Sale: shop deals"']);
});

test("[CS-1] outcome columns line up: accepted, REJECTED and suggest start at one column, and no line is longer than 200 characters", async () => {
  const lines = formatSummary(await runAuditRecorded("storefront"), options).split("\n");
  const rows = lines.filter((l) => /^\s*(\[\d+\])?\s+\S+\s+\S+\s+(deterministic|llm|suggest-only) /.test(l));
  assert.ok(rows.length >= 17, `${rows.length} outcome rows`);
  const starts = new Set(rows.map((l) => l.search(/ (accepted|REJECTED|suggest|gate-rejected) /)));
  assert.equal(starts.size, 1, `status columns: ${[...starts]}`);
  for (const l of lines) assert.ok(l.length <= 200, l);
});

test("[RF-1] a clean page prints no findings and no fixes", () => {
  const text = formatSummary(emptyResult(), { ...options, title: "a11y-fixgate demo" });
  assert.match(text.split("\n")[0]!, /^a11y-fixgate demo \| audit: recorded/);
  assert.match(text, /No findings/);
  assert.match(text, /No fixes to apply/);
});
