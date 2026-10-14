// Browser resolution (spec 5.11, AUD-05, P-1): A11Y_BROWSER_PATH first, then Playwright's chromium if it exists.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { AppError } from "../domain/errors.ts";

export type ResolvedBrowser = { executablePath: string; source: "env" | "playwright" };
export type ResolveDeps = { exists: (path: string) => boolean; playwrightPath: () => string };

const defaultDeps: ResolveDeps = { exists: existsSync, playwrightPath: () => chromium.executablePath() };

/** Version of the installed playwright-core package, read from its package.json. */
export function playwrightCoreVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(require.resolve("playwright-core/package.json"), "utf8")) as { version: string };
  return pkg.version;
}

/** The exact NO_BROWSER text of spec 5.10. */
export function noBrowserMessage(): string {
  return `No Chromium found. Set A11Y_BROWSER_PATH, or run: npm run browser:install (installs the Chromium build of playwright-core ${playwrightCoreVersion()})`;
}

/**
 * Resolves the Chromium executable. A set A11Y_BROWSER_PATH must exist: a missing one throws NO_BROWSER
 * naming the path, without falling through to Playwright's chromium (P-1). Returns null when nothing exists.
 */
export function resolveBrowser(env: { A11Y_BROWSER_PATH?: string | undefined }, deps: ResolveDeps = defaultDeps): ResolvedBrowser | null {
  const fromEnv = env.A11Y_BROWSER_PATH;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (deps.exists(fromEnv)) return { executablePath: fromEnv, source: "env" };
    throw new AppError("NO_BROWSER", `${noBrowserMessage()}. A11Y_BROWSER_PATH points to a missing file: ${fromEnv}`);
  }
  let playwrightPath: string;
  try {
    playwrightPath = deps.playwrightPath();
  } catch {
    return null;
  }
  return playwrightPath !== "" && deps.exists(playwrightPath) ? { executablePath: playwrightPath, source: "playwright" } : null;
}
