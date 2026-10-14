// npm run demo [-- --browser] [-- --out <dir>]  (plan Task 34, spec 1.4, 10.2)
//
// The offline demo: the fixture storefront, the strict fake LLM with fixtures/llm/storefront.json and --lang en,
// whatever LLM_PROVIDER says. Without flags the audits are replayed from tests/fixtures/audits (no browser, no
// network); with --browser they run in a real Chromium (A11Y_BROWSER_PATH, or Playwright's own). Output goes to
// reports/demo unless --out is given. stdout carries the summary through writeOut (redacting); stderr carries one
// JSON log line per event, including the key of every LLM call (spec 5.12).
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { strategyRunnerFor } from "../src/app/llm-strategies.ts";
import { runAudit } from "../src/app/run-audit.ts";
import { createPlaywrightRunner } from "../src/browser/playwright-runner.ts";
import { noBrowserMessage, resolveBrowser } from "../src/browser/browser-resolve.ts";
import { auditConfigSchema } from "../src/contracts/config.ts";
import type { AuditConfig } from "../src/contracts/config.ts";
import { DEFAULT_PROFILE } from "../src/contracts/snapshot.ts";
import { TOOL } from "../src/contracts/tool.ts";
import { AppError, EXIT_CODE_OF } from "../src/domain/errors.ts";
import { pageFileFor } from "../src/domain/map/page-file.ts";
import type { AuditOptions, AuditRunner, AuditTarget } from "../src/domain/ports.ts";
import type { AuditProfile, AuditSnapshot } from "../src/contracts/snapshot.ts";
import { systemClock } from "../src/infra/clock.ts";
import { createLogger } from "../src/infra/logger.ts";
import { createRecordedRunner } from "../src/infra/recorded-runner.ts";
import { existsInsideRoot, readInsideRoot } from "../src/infra/safe-read.ts";
import { scratchFactory } from "../src/infra/scratch.ts";
import { staticServerFactory } from "../src/infra/static-server.ts";
import { writeErr, writeOut } from "../src/infra/write-out.ts";
import { createLlmProvider } from "../src/llm/provider.ts";
import { formatSummary } from "../src/output/summary.ts";
import { writeOutputs } from "../src/output/write-outputs.ts";

const PROJECT = join(import.meta.dirname, "..");
const SOURCE_ROOT = join(PROJECT, "fixtures", "storefront");
const LLM_FIXTURE = join(PROJECT, "fixtures", "llm", "storefront.json");
const RECORDINGS = join(PROJECT, "tests", "fixtures", "audits");

/** Counts the audits a runner answers (the "15 audits" of the last line). */
function countingRunner(inner: AuditRunner): AuditRunner & { audits: () => number } {
  let n = 0;
  return {
    audits: () => n,
    async audit(target: AuditTarget, profile: AuditProfile, opts?: AuditOptions): Promise<AuditSnapshot> {
      n++;
      return inner.audit(target, profile, opts);
    },
    close: () => inner.close(),
  };
}

function parseDemoArgs(argv: string[]): { browser: boolean; out: string } {
  const { values } = parseArgs({ args: argv, strict: true, options: { browser: { type: "boolean" }, out: { type: "string" } } });
  return { browser: values.browser === true, out: values.out === undefined ? join(PROJECT, "reports", "demo") : resolve(process.cwd(), values.out) };
}

/** "report.html  fixes.patch (1 file)  results.sarif (18 results)  audit.json  screenshots/page.png, page.after.png" */
function outputsLine(out: string, written: string[], patchFiles: number, screenshots: string[]): string {
  const shown = relative(process.cwd(), out) || ".";
  const dir = shown.startsWith("..") ? out : shown;
  const parts = written.map((f) => {
    if (f === "fixes.patch") return `${f} (${patchFiles} file${patchFiles === 1 ? "" : "s"})`;
    if (f === "results.sarif") {
      const sarif = JSON.parse(readFileSync(join(out, f), "utf8")) as { runs: Array<{ results: unknown[] }> };
      return `${f} (${sarif.runs[0]!.results.length} results)`;
    }
    return f;
  });
  parts[0] = `${dir}${sep}${parts[0]}`;
  // Only the screenshots this run produced (the snapshots name them); a recorded run has none, even if an older folder exists.
  const names = screenshots.filter((p) => p !== "" && existsSync(join(out, p)));
  if (names.length) parts.push(`${names[0]!.split("/").slice(0, -1).join("/")}/${names.map((p) => p.split("/").at(-1)).join(", ")}`);
  return `Outputs: ${parts.join("  ")}`;
}

async function demo(argv: string[]): Promise<number> {
  const args = parseDemoArgs(argv);
  const logger = createLogger({ component: "cli", level: "info", write: writeErr });

  let inner: AuditRunner;
  let mode: string;
  let browserConfig: AuditConfig["browser"];
  if (args.browser) {
    const browser = resolveBrowser({ A11Y_BROWSER_PATH: process.env["A11Y_BROWSER_PATH"] });
    if (!browser) throw new AppError("NO_BROWSER", noBrowserMessage());
    browserConfig = { executablePath: browser.executablePath, source: browser.source };
    inner = createPlaywrightRunner({ executablePath: browser.executablePath, outDir: args.out, logger: logger.child({ component: "runner" }) });
    mode = browser.source === "env" ? "Chromium (A11Y_BROWSER_PATH)" : "Chromium (Playwright)";
  } else {
    inner = createRecordedRunner(RECORDINGS);
    browserConfig = { executablePath: null, source: "recorded" };
    mode = "recorded (no browser)";
  }
  const runner = countingRunner(inner);
  const onSignal = (): void => void Promise.resolve(runner.close()).finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const config = auditConfigSchema.parse({
    sourceRoot: SOURCE_ROOT,
    pagePath: "/",
    out: args.out,
    lang: "en",
    repoRoot: PROJECT,
    browser: browserConfig,
    llm: { provider: "fake", fixture: LLM_FIXTURE, strict: true },
  });

  const started = Date.now();
  try {
    const llmLogger = logger.child({ component: "llm" });
    const provider = createLlmProvider(config.llm, { readFixture: (path) => JSON.parse(readFileSync(path, "utf8")), logger: llmLogger });
    const run = await runAudit(config, {
      runner,
      llm: strategyRunnerFor(provider, { sourceRoot: config.sourceRoot, pagePath: config.pagePath, logger: llmLogger }),
      servers: staticServerFactory,
      clock: systemClock,
      logger,
      scratch: scratchFactory,
      readPage: (root, rel) => readInsideRoot(root, rel).toString("utf8"),
      exists: existsInsideRoot,
    });
    const { written } = writeOutputs(run, { outDir: config.out, sourceRoot: config.sourceRoot, repoRoot: PROJECT, sarif: true });

    const pageFile = pageFileFor(config.pagePath, (rel) => existsInsideRoot(config.sourceRoot, rel));
    const pageRel = typeof pageFile === "string" ? relative(PROJECT, join(config.sourceRoot, pageFile)).split(sep).join("/") : config.pagePath;
    const pageLine = `Page: ${pageRel} served at ${run.baseline.url}  axe-core ${run.baseline.axeVersion}  tags: ${DEFAULT_PROFILE.axeTags.join(" ")}`;
    writeOut(formatSummary(run, { title: `${TOOL.name} demo`, mode, llmLabel: `fake, strict (${relative(PROJECT, LLM_FIXTURE)})`, pageLine }));
    writeOut("");
    writeOut(outputsLine(config.out, written, Object.keys(run.diffs).length, [run.baseline.screenshots.fullPage, run.combined?.snapshot.screenshots.fullPage ?? ""]));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    writeOut(
      args.browser
        ? `Finished in ${seconds} s (Chromium, ${runner.audits()} audits). npm run demo without flags replays these recordings in under 10 s.`
        : `Finished in ${seconds} s (${runner.audits()} audits replayed from tests/fixtures/audits; recorded mode (no browser)). npm run demo -- --browser runs them in a real Chromium.`,
    );
    return 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await runner.close();
  }
}

if (import.meta.main) {
  process.on("unhandledRejection", (reason) => {
    writeErr(`UNEXPECTED_ERROR: ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(4);
  });
  try {
    process.exitCode = await demo(process.argv.slice(2));
  } catch (error) {
    if (error instanceof AppError) {
      writeErr(`${error.code}: ${error.message}`);
      process.exitCode = EXIT_CODE_OF[error.code];
    } else {
      writeErr(`UNEXPECTED_ERROR: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
      process.exitCode = 4;
    }
  }
}
