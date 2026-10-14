// npm run fixtures:record [-- --check]  (P-7, P-8, docs/recorded-audits.md)
//
// Record mode (needs a browser): runs the whole pipeline (runAudit) of every scenario with the real Playwright
// runner, saves every snapshot under its key with a label (baseline, <findingId>/<strategy>/a<attempt>,
// combined) and rewrites tests/fixtures/audits/<scenario>.<key12>.json. Check mode (no browser): runs every
// scenario with the recorded runner and prints "ok <key12> <scenario> <label>" or "missing ..." per needed key;
// on a miss the scenario's baseline stands in so the run continues; exits 1 if any key is missing.
// Every scenario's formatSummary is printed. Output goes to stderr: stdout is reserved for src/cli.ts and scripts/demo.ts.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { strategyRunnerFor } from "../src/app/llm-strategies.ts";
import { runAudit } from "../src/app/run-audit.ts";
import type { AuditRun } from "../src/app/run-audit.ts";
import { createPlaywrightRunner } from "../src/browser/playwright-runner.ts";
import { noBrowserMessage, resolveBrowser } from "../src/browser/browser-resolve.ts";
import { auditConfigSchema } from "../src/contracts/config.ts";
import type { AuditConfig } from "../src/contracts/config.ts";
import type { AuditProfile, AuditSnapshot, RecordingFile } from "../src/contracts/snapshot.ts";
import { AppError } from "../src/domain/errors.ts";
import type { AuditOptions, AuditRunner, AuditTarget } from "../src/domain/ports.ts";
import { systemClock } from "../src/infra/clock.ts";
import { createLogger } from "../src/infra/logger.ts";
import type { Logger } from "../src/domain/ports.ts";
import { createLlmProvider } from "../src/llm/provider.ts";
import { createRecordedRunner, loadRecordingDir, recordingKey } from "../src/infra/recorded-runner.ts";
import { redactText } from "../src/infra/redact.ts";
import { existsInsideRoot, readInsideRoot } from "../src/infra/safe-read.ts";
import { scratchFactory } from "../src/infra/scratch.ts";
import { staticServerFactory } from "../src/infra/static-server.ts";
import { treeSha256 } from "../src/infra/tree-hash.ts";
import { formatSummary } from "../src/output/summary.ts";

const PROJECT = join(import.meta.dirname, "..");
export const AUDITS_DIR = join(PROJECT, "tests", "fixtures", "audits");
const FIXTURE_ROOT = join(PROJECT, "fixtures", "storefront");
/** The scripted answers of the demo (spec 7.3). */
export const STOREFRONT_LLM = join(PROJECT, "fixtures", "llm", "storefront.json");
const UNCOVERED_ROOT = join(PROJECT, "tests", "fixtures", "sites", "uncovered");
/** Recordings store this URL instead of the random loopback port of the recording run; the recorded runner substitutes the live URL. */
export const RECORDED_URL_ORIGIN = "http://127.0.0.1:0";

const say = (line: string): void => void process.stderr.write(redactText(line) + "\n");

/** One pipeline run: its config without browser and out. The LLM provider is built from config.llm, as the CLI does. */
export type Scenario = { name: string; config: Partial<AuditConfig> & { sourceRoot: string; llm: AuditConfig["llm"] }; llmLabel: string };

/**
 * The scenarios of P-7, in recording order: a key recorded by an earlier scenario keeps its file, so the
 * deterministic candidates shared by storefront-none and storefront are stored once. storefront-write is the
 * storefront with --write on a temporary copy of the fixture (P-7): its extra audit is the verified subset
 * ("write-subset"), the tree that cli.e2e needs. It is a separate scenario so that "storefront" stays a
 * run without --write, whose SARIF and report the unit tests read.
 */
export const SCENARIOS: Scenario[] = [
  { name: "storefront-none", config: { sourceRoot: FIXTURE_ROOT, pagePath: "/", lang: "en", llm: { provider: "none" } }, llmLabel: "none" },
  { name: "storefront", config: { sourceRoot: FIXTURE_ROOT, pagePath: "/", lang: "en", llm: { provider: "fake", fixture: STOREFRONT_LLM, strict: true } }, llmLabel: "fake, strict (fixtures/llm/storefront.json)" },
  { name: "storefront-write", config: { sourceRoot: FIXTURE_ROOT, pagePath: "/", lang: "en", write: true, llm: { provider: "fake", fixture: STOREFRONT_LLM, strict: true } }, llmLabel: "fake, strict, --write on a temporary copy" },
  { name: "uncovered", config: { sourceRoot: UNCOVERED_ROOT, pagePath: "/", lang: null, llm: { provider: "fake", fixture: STOREFRONT_LLM, strict: false } }, llmLabel: "fake, lenient (fixtures/llm/storefront.json)" },
];

/** Strips run-to-run variance before a snapshot is written: no screenshot, zero timings, a fixed origin. */
export function normalizeForRecording(snapshot: AuditSnapshot): AuditSnapshot {
  return {
    ...snapshot,
    url: RECORDED_URL_ORIGIN + snapshot.pagePath,
    screenshots: { fullPage: "" },
    timings: { loadMs: 0, axeMs: 0, keyboardMs: 0 },
  };
}

type Call = { target: AuditTarget; snapshot: AuditSnapshot };

/** Wraps a runner and keeps every audit it answered, in order. */
function recordingRunner(inner: AuditRunner): AuditRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async audit(target: AuditTarget, profile: AuditProfile, opts?: AuditOptions): Promise<AuditSnapshot> {
      const snapshot = await inner.audit(target, profile, opts);
      calls.push({ target, snapshot });
      return snapshot;
    },
    close: () => inner.close(),
  };
}

/**
 * Labels of the audits of one run, in order: the baseline, one per audited candidate (each accepted or
 * rejected outcome, in loop order), the combined audit when there was one, then the --write subset audit.
 */
export function auditLabels(result: AuditRun): string[] {
  const labels = ["baseline"];
  for (const o of result.outcomes) {
    if (o.status === "accepted" || o.status === "rejected") labels.push(`${o.candidate.findingId}/${o.candidate.plan.strategy}/a${o.candidate.plan.llm?.attempt ?? 1}`);
  }
  if (result.combined) labels.push("combined");
  if (result.writeSubsetAudited) labels.push("write-subset");
  return labels;
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/**
 * Runs the whole pipeline of one scenario with the given runner: the config is validated, the LLM provider
 * is built from config.llm (the strict fake reads its fixture here) and runAudit runs with a temp out dir.
 * print: write the scenario's summary to stderr. Also used by tests (runAuditRecorded).
 */
export async function runScenarioPipeline(scenario: Scenario, runner: AuditRunner, browser: AuditConfig["browser"], opts: { print: boolean }): Promise<AuditRun> {
  const out = mkdtempSync(join(tmpdir(), "a11y-record-"));
  // A --write scenario never touches the bundled fixture: it runs on a copy (the tree hash is the same).
  const copy = scenario.config.write ? mkdtempSync(join(tmpdir(), "a11y-record-src-")) : null;
  try {
    if (copy) cpSync(scenario.config.sourceRoot, copy, { recursive: true });
    const config = auditConfigSchema.parse({ ...scenario.config, ...(copy ? { sourceRoot: copy } : {}), out, browser });
    const logger = opts.print ? createLogger({ component: "loop", level: "warn" }) : silent;
    const provider = createLlmProvider(config.llm, { readFixture: (path) => JSON.parse(readFileSync(path, "utf8")) });
    const result = await runAudit(config, {
      runner,
      llm: strategyRunnerFor(provider, { sourceRoot: config.sourceRoot, pagePath: config.pagePath, logger }),
      servers: staticServerFactory,
      clock: systemClock,
      logger,
      scratch: scratchFactory,
      readPage: (root, rel) => readInsideRoot(root, rel).toString("utf8"),
      exists: existsInsideRoot,
    });
    if (opts.print) {
      say("");
      say(`--- ${scenario.name} ---`);
      say(formatSummary(result, { mode: browser.source === "recorded" ? "recorded" : "Chromium", llmLabel: scenario.llmLabel }));
      say("");
    }
    return result;
  } finally {
    rmSync(out, { recursive: true, force: true });
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
}

const runScenario = (scenario: Scenario, runner: AuditRunner, browser: AuditConfig["browser"]): Promise<AuditRun> => runScenarioPipeline(scenario, runner, browser, { print: true });

async function record(): Promise<number> {
  let browser;
  try {
    browser = resolveBrowser({ A11Y_BROWSER_PATH: process.env.A11Y_BROWSER_PATH });
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 3;
  }
  if (!browser) {
    say(noBrowserMessage());
    return 3;
  }
  const previous = new Set(loadRecordingDir(AUDITS_DIR).keys());
  const logger = createLogger({ component: "runner", level: "warn" });
  /** One file per key: the first scenario that needs a key names its file. */
  const files = new Map<string, { file: string; body: RecordingFile }>();
  for (const scenario of SCENARIOS) {
    const runner = recordingRunner(createPlaywrightRunner({ executablePath: browser.executablePath, outDir: null, logger }));
    let result: AuditRun;
    try {
      result = await runScenario(scenario, runner, { executablePath: browser.executablePath, source: browser.source });
    } finally {
      await runner.close();
    }
    const labels = auditLabels(result);
    if (labels.length !== runner.calls.length) throw new Error(`${scenario.name}: ${runner.calls.length} audits but ${labels.length} labels`);
    runner.calls.forEach(({ target, snapshot }, i) => {
      const key = recordingKey(snapshot.treeSha256, target.watch);
      const file = `${scenario.name}.${key.slice(0, 12)}.json`;
      if (!files.has(key)) files.set(key, { file, body: { recordingKey: key, label: labels[i]!, snapshot: normalizeForRecording(snapshot) } });
      say(`${previous.has(key) ? "same" : "new "} ${key.slice(0, 12)} ${scenario.name} ${labels[i]}`);
    });
  }
  for (const f of readdirSync(AUDITS_DIR).filter((n) => n.endsWith(".json"))) rmSync(join(AUDITS_DIR, f));
  for (const { file, body } of files.values()) writeFileSync(join(AUDITS_DIR, file), JSON.stringify(body, null, 2) + "\n");
  const kept = new Set([...files.values()].map((f) => f.body.recordingKey));
  for (const key of previous) if (!kept.has(key)) say(`gone ${key.slice(0, 12)}`);
  say(`wrote ${files.size} recording(s) to tests/fixtures/audits`);
  return 0;
}

function emptySnapshot(target: AuditTarget): AuditSnapshot {
  return {
    schemaVersion: 1, axeVersion: "", treeSha256: treeSha256(target.servedRoot), url: target.url, pagePath: target.pagePath, title: "", lang: null,
    axe: { violations: [], incomplete: [], passesCount: 0, inapplicableCount: 0, toolOptions: {} },
    nodes: {}, domIds: [], traversal: { steps: [], stoppedBecause: "body", interactiveCandidates: [] },
    ariaSnapshot: "", ariaByNode: {}, screenshots: { fullPage: "" }, timings: { loadMs: 0, axeMs: 0, keyboardMs: 0 },
  };
}

async function check(): Promise<number> {
  let missing = 0;
  for (const scenario of SCENARIOS) {
    let baseline: AuditSnapshot | null = null;
    // The scenario's baseline stands in for a missing key so the run continues (P-8); an empty snapshot stands in for a missing baseline.
    const recorded = createRecordedRunner(AUDITS_DIR, { onMissing: (_key, target) => (baseline ? { ...structuredClone(baseline), url: target.url } : emptySnapshot(target)) });
    const runner = recordingRunner(recorded);
    const first = runner.audit.bind(runner);
    runner.audit = async (target, profile, opts) => {
      const snap = await first(target, profile, opts);
      baseline ??= snap;
      return snap;
    };
    const result = await runScenario(scenario, runner, { executablePath: null, source: "recorded" });
    const labels = auditLabels(result);
    recorded.lookups().forEach((l, i) => {
      say(`${l.hit ? "ok" : "missing"} ${l.key.slice(0, 12)} ${scenario.name} ${labels[i] ?? "?"}`);
      if (!l.hit && missing++ === 0) say("keys after the first missing one are provisional");
    });
  }
  return missing === 0 ? 0 : 1;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  try {
    process.exitCode = values.check ? await check() : await record();
  } catch (error) {
    say(error instanceof AppError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
    process.exitCode = 4;
  }
}
