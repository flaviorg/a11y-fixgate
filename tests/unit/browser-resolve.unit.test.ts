import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { noBrowserMessage, resolveBrowser } from "../../src/browser/browser-resolve.ts";
import { AppError } from "../../src/domain/errors.ts";
import { mustRequireBrowser } from "../helpers/browser.ts";

const PW = "/pw/chromium";
const ENV = "/env/chrome-headless-shell";

test("[AUD-05] resolveBrowser prefers an existing A11Y_BROWSER_PATH, then an existing playwright chromium, else null", () => {
  const deps = (existing: string[]) => ({ exists: (p: string) => existing.includes(p), playwrightPath: () => PW });
  assert.deepEqual(resolveBrowser({ A11Y_BROWSER_PATH: ENV }, deps([ENV, PW])), { executablePath: ENV, source: "env" });
  assert.deepEqual(resolveBrowser({}, deps([ENV, PW])), { executablePath: PW, source: "playwright" });
  assert.deepEqual(resolveBrowser({ A11Y_BROWSER_PATH: "" }, deps([PW])), { executablePath: PW, source: "playwright" });
  assert.equal(resolveBrowser({}, deps([])), null);
  const throwing = { exists: () => false, playwrightPath: () => { throw new Error("no registry"); } };
  assert.equal(resolveBrowser({}, throwing), null);
});

test("[P-1] an A11Y_BROWSER_PATH that does not exist throws NO_BROWSER naming the path", () => {
  const deps = { exists: (p: string) => p === PW, playwrightPath: () => PW };
  assert.throws(
    () => resolveBrowser({ A11Y_BROWSER_PATH: "/missing/chrome" }, deps),
    (err: unknown) => err instanceof AppError && err.code === "NO_BROWSER" && err.message.includes("/missing/chrome") && err.message.includes("A11Y_BROWSER_PATH"),
  );
});

test("[AUD-05] the no-browser message names A11Y_BROWSER_PATH, npm run browser:install and the installed playwright-core version", () => {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(require.resolve("playwright-core/package.json"), "utf8")) as { version: string };
  assert.equal(pkg.version, "1.64.0");
  assert.equal(
    noBrowserMessage(),
    `No Chromium found. Set A11Y_BROWSER_PATH, or run: npm run browser:install (installs the Chromium build of playwright-core ${pkg.version})`,
  );
});

test("[AUD-05] without a browser, tests skip unless REQUIRE_BROWSER=1 or CI is set", () => {
  assert.deepEqual([{}, { REQUIRE_BROWSER: "1" }, { CI: "true" }].map(mustRequireBrowser), [false, true, true]);
  assert.deepEqual([{ REQUIRE_BROWSER: "0" }, { REQUIRE_BROWSER: "" }, { CI: "" }, { CI: "false" }].map(mustRequireBrowser), [false, false, false, false]);
});
