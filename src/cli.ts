// The command line (spec 5.9, 5.10, 5.11; plan Task 32): node src/cli.ts audit --src <dir> [flags].
// parseCli is pure over (argv, env, cwd, toolDir). main wires the runner, the provider, the pipeline and the outputs.
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { strategyRunnerFor } from "./app/llm-strategies.ts";
import { CombinedMismatchError, runAudit } from "./app/run-audit.ts";
import type { AuditRun } from "./app/run-audit.ts";
import { noBrowserMessage, resolveBrowser } from "./browser/browser-resolve.ts";
import { createPlaywrightRunner } from "./browser/playwright-runner.ts";
import { auditConfigSchema } from "./contracts/config.ts";
import type { AuditConfig } from "./contracts/config.ts";
import type { Finding, Impact } from "./contracts/finding.ts";
import { TOOL } from "./contracts/tool.ts";
import { AppError, EXIT_CODE_OF } from "./domain/errors.ts";
import { remainingFindings } from "./domain/findings.ts";
import type { AuditRunner, Logger, Scratch, ScratchFactory, StaticServerFactory } from "./domain/ports.ts";
import { systemClock } from "./infra/clock.ts";
import { createLogger } from "./infra/logger.ts";
import type { LogLevel } from "./infra/logger.ts";
import { redactText } from "./infra/redact.ts";
import { createRecordedRunner } from "./infra/recorded-runner.ts";
import { existsInsideRoot, readInsideRoot } from "./infra/safe-read.ts";
import { scratchFactory } from "./infra/scratch.ts";
import { staticServerFactory } from "./infra/static-server.ts";
import { writeErr, writeOut } from "./infra/write-out.ts";
import { createLlmProvider } from "./llm/provider.ts";
import { formatSummary, formatSummaryJson } from "./output/summary.ts";
import { writeOutputs } from "./output/write-outputs.ts";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];
const IMPACT_RANK: Record<Impact, number> = { minor: 1, moderate: 2, serious: 3, critical: 4 };

export const HELP = `${TOOL.name} ${TOOL.version}: an LLM-assisted accessibility fixer with a deterministic verification loop.

Usage:
  node src/cli.ts audit --src <dir> [flags]       (npm run audit -- <flags> is the same command)
  node src/cli.ts --help | --version

Flags:
  --src <dir>                 Static site root (required). Relative paths resolve against the current directory
  --page /path                Page to audit (default /)
  --out <dir>                 Output directory (default reports/latest, or A11Y_OUT)
  --no-fix                    Audit only: no fix is tried
  --max-fixes N               Cap on accepted fixes (0 to 100, default 25)
  --max-candidates N          Cap on verified candidates, i.e. browser re-audits (1 to 300, default 60)
  --max-llm-calls N           Cap on LLM calls (0 to 200, default 40)
  --deadline <seconds>        Wall-clock cap for the run (10 to 3600, default 600)
  --lang <tag>                BCP 47 tag for the html-lang fixer (without it the fixer needs a page signal)
  --write                     Write the verified fixes into --src; needs-review fixes stay in fixes.patch
  --no-sarif                  Do not write results.sarif
  --repo-root <dir>           Directory SARIF uri values are relative to (A11Y_REPO_ROOT, GITHUB_WORKSPACE, or the current directory)
  --fail-on none|minor|moderate|serious|critical
                              Exit 1 when a violation at or above that impact is still in the source files
                              (needs-review items and fixes that exist only in fixes.patch never count)
  --allow-new-incomplete      Do not reject a fix because a new needs-review item appeared
  --llm none|fake|openai-compatible
                              LLM provider (LLM_PROVIDER, default fake: lenient, bundled fixtures/llm/storefront.json)
  --llm-fixture <file>        Fixture of the fake provider
  --strict-fake               An unscripted LLM call is an error instead of a suggestion
  --recorded <dir>            Replay recorded audits instead of using a browser
  --json                      Print the summary counters as one JSON line on stdout

Exit codes: 0 done, 1 --fail-on or COMBINED_MISMATCH, 2 usage or configuration, 3 no browser, 4 audit error, 5 LLM unavailable.
Environment: LLM_PROVIDER, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS, LLM_REQUEST_OVERRIDES, A11Y_REPO_ROOT, A11Y_BROWSER_PATH, LOG_LEVEL, A11Y_OUT.`;

export type ParsedCli =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; config: AuditConfig; recorded: string | null; json: boolean; strictFake: boolean; logLevel: LogLevel }
  | { kind: "error"; code: "USAGE" | "CONFIG_INVALID"; message: string };

const usage = (flag: string, rule: string): ParsedCli => ({ kind: "error", code: "USAGE", message: `Invalid usage: ${flag}: ${rule}` });
const invalid = (name: string, issue: string): ParsedCli => ({ kind: "error", code: "CONFIG_INVALID", message: `Invalid configuration: ${name}: ${issue}` });

/** The flag or variable that owns a config path, for messages. */
const NAME_OF: Record<string, string> = {
  sourceRoot: "--src", pagePath: "--page", out: "--out", maxFixes: "--max-fixes", maxCandidates: "--max-candidates", maxLlmCalls: "--max-llm-calls",
  deadlineMs: "--deadline", lang: "--lang", failOn: "--fail-on", repoRoot: "--repo-root", "llm.baseUrl": "LLM_BASE_URL", "llm.model": "LLM_MODEL",
  "llm.apiKey": "LLM_API_KEY", "llm.timeoutMs": "LLM_TIMEOUT_MS", "llm.requestOverrides": "LLM_REQUEST_OVERRIDES", "llm.fixture": "--llm-fixture", llm: "--llm",
};

/** Non-negative integer from a flag value, or null. */
function wholeNumber(text: string): number | null {
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/** An environment variable that is set and not empty. */
const envOf = (env: Record<string, string | undefined>, name: string): string | undefined => (env[name] === undefined || env[name] === "" ? undefined : env[name]);

export function parseCli(argv: string[], env: Record<string, string | undefined>, ctx: { cwd: string; toolDir: string }): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean" }, version: { type: "boolean" },
        src: { type: "string" }, page: { type: "string" }, out: { type: "string" },
        "no-fix": { type: "boolean" }, "max-fixes": { type: "string" }, "max-candidates": { type: "string" }, "max-llm-calls": { type: "string" },
        deadline: { type: "string" }, lang: { type: "string" }, write: { type: "boolean" }, "no-sarif": { type: "boolean" },
        "repo-root": { type: "string" }, "fail-on": { type: "string" }, "allow-new-incomplete": { type: "boolean" },
        llm: { type: "string" }, "llm-fixture": { type: "string" }, "strict-fake": { type: "boolean" }, recorded: { type: "string" }, json: { type: "boolean" },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const flag = /'(--?[A-Za-z][\w-]*)/.exec(message)?.[1] ?? "argument";
    const missingValue = (error as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    return usage(flag, missingValue ? "needs a value" : "unknown flag (see --help)");
  }
  const v = parsed.values;
  if (v.help) return { kind: "help" };
  if (v.version) return { kind: "version" };
  const [command, ...extra] = parsed.positionals;
  if (command !== "audit") return usage("command", "expected 'audit' (see --help)");
  if (extra.length > 0) return usage(extra[0]!, "unexpected argument");
  if (v.src === undefined || v.src === "") return usage("--src", "required");

  const numbers: Record<string, number> = {};
  for (const [flag, key] of [["max-fixes", "maxFixes"], ["max-candidates", "maxCandidates"], ["max-llm-calls", "maxLlmCalls"], ["deadline", "deadlineMs"]] as const) {
    const text = v[flag];
    if (text === undefined) continue;
    const n = wholeNumber(text);
    if (n === null) return usage(`--${flag}`, "must be a non-negative integer");
    numbers[key] = key === "deadlineMs" ? n * 1000 : n;
  }

  const logLevel = envOf(env, "LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.includes(logLevel)) return invalid("LOG_LEVEL", `must be one of ${LOG_LEVELS.join(", ")}`);

  // LLM provider: --llm, then LLM_PROVIDER, then the lenient fake.
  const provider = v.llm ?? envOf(env, "LLM_PROVIDER") ?? "fake";
  let llm: unknown;
  if (provider === "none") {
    if (v["llm-fixture"] !== undefined) return usage("--llm-fixture", "only valid with --llm fake");
    if (v["strict-fake"]) return usage("--strict-fake", "only valid with --llm fake");
    llm = { provider: "none" };
  } else if (provider === "fake") {
    llm = { provider: "fake", fixture: v["llm-fixture"] !== undefined ? resolve(ctx.cwd, v["llm-fixture"]) : join(ctx.toolDir, "fixtures", "llm", "storefront.json"), strict: v["strict-fake"] === true };
  } else if (provider === "openai-compatible") {
    if (v["llm-fixture"] !== undefined) return usage("--llm-fixture", "only valid with --llm fake");
    if (v["strict-fake"]) return usage("--strict-fake", "only valid with --llm fake");
    const apiKey = envOf(env, "LLM_API_KEY");
    if (apiKey === undefined) return invalid("LLM_API_KEY", "required with --llm openai-compatible");
    if (apiKey.length < 8) return invalid("LLM_API_KEY", "must be at least 8 characters");
    const model = envOf(env, "LLM_MODEL");
    if (model === undefined) return invalid("LLM_MODEL", "required with --llm openai-compatible");
    const timeoutText = envOf(env, "LLM_TIMEOUT_MS");
    const timeoutMs = timeoutText === undefined ? 30000 : wholeNumber(timeoutText);
    if (timeoutMs === null) return invalid("LLM_TIMEOUT_MS", "must be an integer from 1000 to 120000");
    let requestOverrides: unknown = {};
    const overridesText = envOf(env, "LLM_REQUEST_OVERRIDES");
    if (overridesText !== undefined) {
      try {
        requestOverrides = JSON.parse(overridesText);
      } catch {
        return invalid("LLM_REQUEST_OVERRIDES", "must be a JSON object");
      }
      if (requestOverrides === null || typeof requestOverrides !== "object" || Array.isArray(requestOverrides)) return invalid("LLM_REQUEST_OVERRIDES", "must be a JSON object");
    }
    llm = { provider, baseUrl: envOf(env, "LLM_BASE_URL") ?? DEFAULT_BASE_URL, model, apiKey, timeoutMs, requestOverrides };
  } else {
    return invalid(v.llm !== undefined ? "--llm" : "LLM_PROVIDER", "must be one of none, fake, openai-compatible");
  }

  const recorded = v.recorded !== undefined ? resolve(ctx.cwd, v.recorded) : null;
  const candidate = {
    sourceRoot: resolve(ctx.cwd, v.src),
    ...(v.page !== undefined ? { pagePath: v.page } : {}),
    out: resolve(ctx.cwd, v.out ?? envOf(env, "A11Y_OUT") ?? "reports/latest"),
    write: v.write === true,
    fix: v["no-fix"] !== true,
    ...numbers,
    ...(v.lang !== undefined ? { lang: v.lang } : {}),
    ...(v["fail-on"] !== undefined ? { failOn: v["fail-on"] } : {}),
    sarif: v["no-sarif"] !== true,
    repoRoot: resolve(ctx.cwd, v["repo-root"] ?? envOf(env, "A11Y_REPO_ROOT") ?? envOf(env, "GITHUB_WORKSPACE") ?? ctx.cwd),
    allowNewIncomplete: v["allow-new-incomplete"] === true,
    browser: { executablePath: null, source: recorded !== null ? "recorded" : "env" },
    llm,
  };
  const checked = auditConfigSchema.safeParse(candidate);
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    const path = issue.path.join(".");
    // Messages come from the schema and never carry the offending value.
    return invalid(NAME_OF[path] ?? NAME_OF[String(issue.path[0])] ?? (path || "configuration"), issue.message);
  }
  return { kind: "run", config: checked.data, recorded, json: v.json === true, strictFake: v["strict-fake"] === true, logLevel: logLevel as LogLevel };
}

/** --fail-on (P-2, CLI-02): true when a violation at or above the level is among the findings still in the source files. needs-review items never count. */
export function failOnTriggered(findings: Finding[], level: AuditConfig["failOn"]): boolean {
  if (level === "none") return false;
  return findings.some((f) => f.status === "violation" && IMPACT_RANK[f.impact] >= IMPACT_RANK[level]);
}

export type CliIo = {
  /** One line or block per call, without a trailing newline. */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
};

const errorLine = (code: string, message: string): string => `${code}: ${message}`;

/** Keeps track of what is open so a signal can close it. */
function tracked(servers: StaticServerFactory, scratch: ScratchFactory): { servers: StaticServerFactory; scratch: ScratchFactory; cleanup: () => Promise<void> } {
  const openServers = new Set<{ close(): Promise<void> }>();
  const copies = new Set<Scratch>();
  return {
    servers: {
      async start(root) {
        const server = await servers.start(root);
        openServers.add(server);
        return { url: server.url, close: async () => void (openServers.delete(server), await server.close()) };
      },
    },
    scratch: {
      async create(sourceRoot, options) {
        const copy = await scratch.create(sourceRoot, options);
        copies.add(copy);
        return { ...copy, dispose: () => void (copies.delete(copy), copy.dispose()) };
      },
    },
    async cleanup() {
      for (const s of [...openServers]) await s.close().catch(() => {});
      for (const c of [...copies]) c.dispose();
    },
  };
}

function readFixture(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new AppError("CONFIG_INVALID", `Invalid configuration: --llm-fixture: cannot read or parse the fixture file`);
  }
}

/**
 * Runs the command and returns the exit code. Errors never escape: an AppError prints "<CODE>: <text>" and maps to
 * its exit code (spec 5.10), anything else is an audit infrastructure failure (4).
 */
export async function main(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const toolDir = join(import.meta.dirname, "..");
  const out = (text: string): void => io.stdout(redactText(text));
  const err = (text: string): void => io.stderr(redactText(text));
  const parsed = parseCli(argv, env, { cwd: io.cwd, toolDir });
  if (parsed.kind === "help") {
    out(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    out(`${TOOL.name} ${TOOL.version}`);
    return 0;
  }
  if (parsed.kind === "error") {
    err(errorLine(parsed.code, parsed.message));
    return EXIT_CODE_OF[parsed.code];
  }

  const logger: Logger = createLogger({ component: "cli", level: parsed.logLevel, write: err });
  const resources = tracked(staticServerFactory, scratchFactory);
  const abort = new AbortController();
  let runner = null as AuditRunner | null;
  const onSignal = (signal: NodeJS.Signals): void => {
    abort.abort();
    logger.warn("interrupted", { signal });
    void Promise.resolve(runner?.close())
      .catch(() => {})
      .then(() => resources.cleanup())
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await execute(parsed, env, io, { logger, resources, signal: abort.signal, setRunner: (r) => void (runner = r) });
  } catch (error) {
    if (error instanceof AppError) {
      logger.error("failed", { code: error.code, details: error.details instanceof Object && !(error instanceof CombinedMismatchError) ? error.details : undefined });
      err(errorLine(error.code, error.message));
      return EXIT_CODE_OF[error.code];
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("failed", { code: "UNEXPECTED", message });
    err(errorLine("UNEXPECTED_ERROR", message.slice(0, 500)));
    return 4;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await Promise.resolve(runner?.close()).catch(() => {});
    await resources.cleanup();
  }
}

type Run = Extract<ParsedCli, { kind: "run" }>;

async function execute(
  parsed: Run,
  env: Record<string, string | undefined>,
  io: CliIo,
  ctx: { logger: Logger; resources: ReturnType<typeof tracked>; signal: AbortSignal; setRunner: (r: AuditRunner) => void },
): Promise<number> {
  const { logger } = ctx;
  const out = (text: string): void => io.stdout(redactText(text));
  const err = (text: string): void => io.stderr(redactText(text));
  const config: AuditConfig = parsed.config;

  // The audit runner: a recording, or a real Chromium.
  let runner: AuditRunner;
  let mode: string;
  if (parsed.recorded !== null) {
    try {
      runner = createRecordedRunner(parsed.recorded);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("CONFIG_INVALID", "Invalid configuration: --recorded: cannot read the recordings directory");
    }
    mode = "recorded";
  } else {
    const browser = resolveBrowser({ A11Y_BROWSER_PATH: env["A11Y_BROWSER_PATH"] });
    if (!browser) throw new AppError("NO_BROWSER", noBrowserMessage());
    config.browser = { executablePath: browser.executablePath, source: browser.source };
    runner = createPlaywrightRunner({ executablePath: browser.executablePath, outDir: config.out, logger: logger.child({ component: "runner" }) });
    mode = browser.source === "env" ? "Chromium (A11Y_BROWSER_PATH)" : "Chromium (Playwright)";
  }
  ctx.setRunner(runner);

  const llmLogger = logger.child({ component: "llm" });
  const provider = createLlmProvider(config.llm, { readFixture, fetch: globalThis.fetch, logger: llmLogger });
  const llm = strategyRunnerFor(provider, { sourceRoot: config.sourceRoot, pagePath: config.pagePath, logger: llmLogger, signal: ctx.signal });
  const llmLabel =
    config.llm.provider === "fake" ? `fake, ${config.llm.strict ? "strict" : "lenient"} (${relative(io.cwd, config.llm.fixture ?? "") || "bundled"})` : config.llm.provider === "openai-compatible" ? `openai-compatible (${config.llm.model})` : "none";

  let run: AuditRun;
  let mismatch: CombinedMismatchError | null = null;
  try {
    run = await runAudit(config, {
      runner,
      llm,
      servers: ctx.resources.servers,
      clock: systemClock,
      logger,
      scratch: ctx.resources.scratch,
      readPage: (root, rel) => readInsideRoot(root, rel).toString("utf8"),
      exists: existsInsideRoot,
    });
  } catch (error) {
    if (!(error instanceof CombinedMismatchError)) throw error;
    mismatch = error;
    run = error.run;
  }

  const repoRoot = config.repoRoot ?? io.cwd;
  const { written } = writeOutputs(run, { outDir: config.out, sourceRoot: config.sourceRoot, repoRoot, sarif: config.sarif });
  logger.info("outputs_written", { files: written });

  if (parsed.json) out(formatSummaryJson(run));
  else {
    out(formatSummary(run, { mode, llmLabel }));
    const rel = relative(io.cwd, config.out) || ".";
    const shown = rel.startsWith("..") ? config.out : rel; // far away: the absolute path reads better than ../../..
    out(`Outputs: ${written.map((f) => `${shown}/${f}`).join("  ")}`);
    if (written.includes("fixes.patch")) out(`Apply with: git apply ${shown}/fixes.patch   (from the repository root; or --write for the verified fixes)`);
  }

  if (mismatch) {
    err(errorLine(mismatch.code, mismatch.message));
    return EXIT_CODE_OF[mismatch.code];
  }
  if (failOnTriggered(remainingFindings(run), config.failOn)) {
    err(`--fail-on ${config.failOn}: a violation at or above that level is still in the source files (see the summary)`);
    return 1;
  }
  if (run.warnings.includes("llm-unavailable")) {
    err(errorLine("LLM_UNAVAILABLE", `LLM provider unavailable after 2 attempts (${run.llmUnavailableKind ?? "unknown"}); LLM strategies skipped`));
    return EXIT_CODE_OF.LLM_UNAVAILABLE;
  }
  return 0;
}

if (import.meta.main) {
  process.on("unhandledRejection", (reason) => {
    writeErr(errorLine("UNEXPECTED_ERROR", reason instanceof Error ? reason.message : String(reason)));
    process.exit(4);
  });
  process.exitCode = await main(process.argv.slice(2), process.env, { stdout: writeOut, stderr: writeErr, cwd: process.cwd() });
}
