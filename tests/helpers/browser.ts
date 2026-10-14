// Browser availability for e2e tests (spec 5.11, AUD-05). The only test code that reads A11Y_BROWSER_PATH, REQUIRE_BROWSER and CI.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { resolveBrowser } from "../../src/browser/browser-resolve.ts";

/** Pure decision: a missing browser fails the test when REQUIRE_BROWSER=1 or CI is set (and not "false" or "0"). */
export function mustRequireBrowser(env: { REQUIRE_BROWSER?: string | undefined; CI?: string | undefined }): boolean {
  if (env.REQUIRE_BROWSER === "1") return true;
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
}

/** The browser executable, or null after t.skip() when none is found and none is required. Fails the test when one is required. */
export function browserPathOrSkip(t: TestContext): string | null {
  let resolved: { executablePath: string } | null;
  let reason = "no browser: set A11Y_BROWSER_PATH";
  try {
    resolved = resolveBrowser({ A11Y_BROWSER_PATH: process.env.A11Y_BROWSER_PATH });
  } catch (error) {
    resolved = null;
    reason = error instanceof Error ? error.message : String(error);
  }
  if (resolved) return resolved.executablePath;
  if (mustRequireBrowser(process.env)) assert.fail(`${reason} (REQUIRE_BROWSER=1 or CI is set, so this test fails instead of skipping)`);
  t.skip(reason);
  return null;
}
