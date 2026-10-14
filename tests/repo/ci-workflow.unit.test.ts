// .github/workflows/ci.yml (plan Task 36; REP-08, CS-9): line matching, no YAML parser.
import test from "node:test";
import assert from "node:assert/strict";
import { readRepoFile } from "../helpers/repo-files.ts";

const ci = readRepoFile(".github/workflows/ci.yml");
const lines = ci.split("\n").map((l) => l.trimEnd());
const has = (re: RegExp): boolean => lines.some((l) => re.test(l));

test("[REP-08] ci.yml installs the browser with npm run browser:install, sets REQUIRE_BROWSER=1, and uses actions/checkout@v7 and actions/setup-node@v7 with node-version-file: .nvmrc", () => {
  assert.ok(has(/^\s*- run: npm run browser:install$/), "browser:install step");
  assert.ok(has(/^\s*REQUIRE_BROWSER: "1"$/), 'REQUIRE_BROWSER: "1"');
  assert.ok(has(/^\s*- uses: actions\/checkout@v7$/), "checkout@v7");
  assert.ok(has(/^\s*- uses: actions\/setup-node@v7$/), "setup-node@v7");
  assert.ok(has(/^\s*node-version-file: \.nvmrc$/), "node-version-file");
});

test("[CS-9] ci.yml runs on push and pull_request with read-only permissions, one verify job, and the checks of the verify script, with no secret", () => {
  assert.ok(has(/^name: CI$/));
  assert.ok(has(/^on: \[push, pull_request\]$/));
  assert.ok(lines.includes("permissions:") && has(/^\s{2}contents: read$/));
  assert.ok(has(/^\s{2}verify:$/) && has(/^\s{4}runs-on: ubuntu-latest$/) && has(/^\s{4}timeout-minutes: 20$/));
  assert.ok(has(/^\s*cache: npm$/));
  const order = ["npm ci", "npm run browser:install", "npm run typecheck", "npm run test:coverage", "npm run check:secrets", "npm run demo"].map((cmd) => lines.findIndex((l) => l.trim() === `- run: ${cmd}`));
  assert.ok(order.every((i) => i >= 0), `missing step: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "steps run in this order");
  assert.ok(!/secrets\./.test(ci), "no secret is referenced");
  assert.ok(!/LLM_API_KEY|LLM_PROVIDER/.test(ci), "no LLM variable is set: CI never needs a key");
});
