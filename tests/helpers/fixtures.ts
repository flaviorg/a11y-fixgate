// Paths of the bundled fixtures used by tests and scripts, and the full-pipeline run on a fixture copy.
import { cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { runAudit } from "../../src/app/run-audit.ts";
import type { AuditRun } from "../../src/app/run-audit.ts";
import { createPlaywrightRunner } from "../../src/browser/playwright-runner.ts";
import { auditConfigSchema } from "../../src/contracts/config.ts";
import type { AuditConfig } from "../../src/contracts/config.ts";
import type { LlmStrategyRunner } from "../../src/domain/fix/types.ts";
import { systemClock } from "../../src/infra/clock.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { existsInsideRoot, readInsideRoot } from "../../src/infra/safe-read.ts";
import { scratchFactory } from "../../src/infra/scratch.ts";
import { staticServerFactory } from "../../src/infra/static-server.ts";
import { tmpDir } from "./tmp.ts";

const PROJECT = resolve(import.meta.dirname, "..", "..");

/** The storefront fixture of spec 5.15. */
export const FIXTURE_ROOT = join(PROJECT, "fixtures", "storefront");
/** Recorded audit snapshots (P-7). */
export const AUDITS_DIR = join(PROJECT, "tests", "fixtures", "audits");
/** Small extra pages (csp, isolation, uncovered, clean). */
export const SITES_DIR = join(PROJECT, "tests", "fixtures", "sites");

/** Reads a fixture file (relative posix path under fixtures/storefront) as UTF-8 text. */
export function readFixture(rel: string): string {
  return readFileSync(join(FIXTURE_ROOT, ...rel.split("/")), "utf8");
}

/** Small HTML files for the index and mapping tests (Task 13). */
export const HTML_DIR = join(PROJECT, "tests", "fixtures", "html");

/** Reads tests/fixtures/html/<name> byte-exact as UTF-8 text (a BOM, if any, is kept). */
export function readHtmlFixture(name: string): string {
  return readFileSync(join(HTML_DIR, name), "utf8");
}

/**
 * Overrides for runAuditOnFixtureCopy: config fields plus the LLM strategy runner (null: --llm none), or a
 * factory that receives the copy's root (the runner reads images from it).
 */
export type FixtureRunOverrides = Partial<Omit<AuditConfig, "llm">> & { llm?: LlmStrategyRunner | null | ((root: string) => LlmStrategyRunner | null) };

/**
 * Copies the storefront to a temp dir and runs the whole pipeline on it with the real Playwright runner,
 * lang "en" and a temp out dir (Task 23). The copies are removed when the test ends.
 */
export async function runAuditOnFixtureCopy(t: TestContext, executablePath: string, overrides: FixtureRunOverrides = {}): Promise<AuditRun & { root: string; out: string }> {
  const { llm = null, ...config } = overrides;
  const root = tmpDir(t, "a11y-fixture-");
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  const out = tmpDir(t, "a11y-out-");
  const logger = createLogger({ component: "runner", level: "error", write: () => {} });
  const runner = createPlaywrightRunner({ executablePath, outDir: out, logger });
  try {
    const parsed = auditConfigSchema.parse({ sourceRoot: root, out, lang: "en", browser: { executablePath, source: "env" }, llm: { provider: "none" }, ...config });
    const result = await runAudit(parsed, {
      runner,
      llm: typeof llm === "function" ? llm(root) : llm,
      servers: staticServerFactory,
      clock: systemClock,
      logger,
      scratch: scratchFactory,
      readPage: (r, rel) => readInsideRoot(r, rel).toString("utf8"),
      exists: existsInsideRoot,
    });
    return { ...result, root, out };
  } finally {
    await runner.close();
  }
}
