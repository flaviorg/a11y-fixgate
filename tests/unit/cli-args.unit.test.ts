// The command line parser and the --fail-on decision (spec 5.9, 5.11; plan Task 32).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Finding } from "../../src/contracts/finding.ts";
import { TOOL } from "../../src/contracts/tool.ts";
import { HELP, failOnTriggered, main, parseCli } from "../../src/cli.ts";
import { makeNode } from "../helpers/snapshots.ts";

const CTX = { cwd: "/work/clone", toolDir: "/opt/tool" };
const run = (argv: string[], env: Record<string, string | undefined> = {}) => parseCli(argv, env, CTX);

function ok(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = run(argv, env);
  assert.equal(parsed.kind, "run", JSON.stringify(parsed));
  return parsed.kind === "run" ? parsed : (undefined as never);
}

function finding(impact: Finding["impact"], status: Finding["status"], ruleId = "image-alt"): Finding {
  return { id: `${ruleId}-1`, source: "axe", ruleId, status, impact, wcag: [], level: "A", help: "", helpUrl: "", message: "", node: makeNode({ tag: "img" }), location: { reason: "no-candidate" }, fingerprint: "0123456789abcdef" as Finding["fingerprint"], data: {} };
}

test("[CLI-01] unknown flags and missing --src are USAGE (exit 2) and name the flag", () => {
  assert.deepEqual(run(["audit", "--src", "site", "--frobnicate"]), { kind: "error", code: "USAGE", message: "Invalid usage: --frobnicate: unknown flag (see --help)" });
  assert.deepEqual(run(["audit"]), { kind: "error", code: "USAGE", message: "Invalid usage: --src: required" });
  assert.deepEqual(run(["audit", "--src"]), { kind: "error", code: "USAGE", message: "Invalid usage: --src: needs a value" });
  assert.deepEqual(run([]), { kind: "error", code: "USAGE", message: "Invalid usage: command: expected 'audit' (see --help)" });
  assert.deepEqual(run(["scan", "--src", "x"]), { kind: "error", code: "USAGE", message: "Invalid usage: command: expected 'audit' (see --help)" });
  assert.deepEqual(run(["audit", "--src", "x", "stray"]), { kind: "error", code: "USAGE", message: "Invalid usage: stray: unexpected argument" });
  assert.deepEqual(run(["audit", "--src", "x", "--max-fixes", "many"]), { kind: "error", code: "USAGE", message: "Invalid usage: --max-fixes: must be a non-negative integer" });
  assert.deepEqual(run(["audit", "--src", "x", "--llm", "none", "--llm-fixture", "f.json"]), { kind: "error", code: "USAGE", message: "Invalid usage: --llm-fixture: only valid with --llm fake" });
  assert.deepEqual(run(["--help"]), { kind: "help" });
  assert.deepEqual(run(["--version"]), { kind: "version" });
  assert.deepEqual(run(["audit", "--help"]), { kind: "help" });
  for (const flag of ["--src", "--page", "--out", "--no-fix", "--max-fixes", "--max-candidates", "--max-llm-calls", "--deadline", "--lang", "--write", "--no-sarif", "--repo-root", "--fail-on", "--allow-new-incomplete", "--llm", "--llm-fixture", "--strict-fake", "--recorded", "--json"]) {
    assert.ok(HELP.includes(flag), `help documents ${flag}`);
  }
});

test("[LLM-06] openai-compatible without LLM_API_KEY or LLM_MODEL is CONFIG_INVALID naming the variable, and the message contains no value", () => {
  const base = ["audit", "--src", "site", "--llm", "openai-compatible"];
  assert.deepEqual(run(base), { kind: "error", code: "CONFIG_INVALID", message: "Invalid configuration: LLM_API_KEY: required with --llm openai-compatible" });
  const key = "sk-or-v1-" + "k".repeat(30);
  assert.deepEqual(run(base, { LLM_API_KEY: key }), { kind: "error", code: "CONFIG_INVALID", message: "Invalid configuration: LLM_MODEL: required with --llm openai-compatible" });
  const short = run(base, { LLM_API_KEY: "abc123", LLM_MODEL: "m" });
  assert.equal(short.kind, "error");
  assert.equal(short.kind === "error" && short.message, "Invalid configuration: LLM_API_KEY: must be at least 8 characters");
  assert.equal(JSON.stringify(short).includes("abc123"), false);
  for (const env of [{ LLM_API_KEY: key, LLM_MODEL: "m", LLM_BASE_URL: "http://example.com/v1" }, { LLM_API_KEY: key, LLM_MODEL: "m", LLM_BASE_URL: "javascript:alert(1)" }]) {
    const bad = run(base, env);
    assert.equal(bad.kind === "error" && bad.code, "CONFIG_INVALID");
    assert.match(bad.kind === "error" ? bad.message : "", /LLM_BASE_URL/);
    assert.equal(JSON.stringify(bad).includes(key), false);
  }
  const timeout = run(base, { LLM_API_KEY: key, LLM_MODEL: "m", LLM_TIMEOUT_MS: "5" });
  assert.match(timeout.kind === "error" ? timeout.message : "", /LLM_TIMEOUT_MS/);
  const overrides = run(base, { LLM_API_KEY: key, LLM_MODEL: "m", LLM_REQUEST_OVERRIDES: "{nope" });
  assert.equal(overrides.kind === "error" && overrides.message, "Invalid configuration: LLM_REQUEST_OVERRIDES: must be a JSON object");
  const good = ok(base, { LLM_API_KEY: key, LLM_MODEL: "gpt-x", LLM_REQUEST_OVERRIDES: '{"max_tokens":null,"max_completion_tokens":300}', LLM_TIMEOUT_MS: "5000" });
  assert.deepEqual(good.config.llm, { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "gpt-x", apiKey: key, timeoutMs: 5000, requestOverrides: { max_tokens: null, max_completion_tokens: 300 } });
  assert.equal(run(["audit", "--src", "s", "--llm", "anthropic"]).kind, "error");
  assert.match(JSON.stringify(run(["audit", "--src", "s"], { LLM_PROVIDER: "claude" })), /LLM_PROVIDER/);
});

test("[CLI-05] the default fake fixture resolves from toolDir, not cwd, and a relative --src resolves against cwd", () => {
  const parsed = ok(["audit", "--src", "fixtures/storefront"]);
  assert.equal(parsed.config.sourceRoot, "/work/clone/fixtures/storefront");
  assert.deepEqual(parsed.config.llm, { provider: "fake", fixture: join("/opt/tool", "fixtures", "llm", "storefront.json"), strict: false });
  assert.equal(parsed.config.out, "/work/clone/reports/latest");
  assert.equal(parsed.recorded, null);
  assert.deepEqual(parsed.config.browser, { executablePath: null, source: "env" });
  // --llm-fixture is relative to cwd, --out and --recorded too; an absolute path is kept.
  const flags = ok(["audit", "--src", "/abs/site", "--llm-fixture", "mine.json", "--strict-fake", "--out", "o", "--recorded", "tests/fixtures/audits", "--json"]);
  assert.equal(flags.config.sourceRoot, "/abs/site");
  assert.deepEqual(flags.config.llm, { provider: "fake", fixture: "/work/clone/mine.json", strict: true });
  assert.equal(flags.config.out, "/work/clone/o");
  assert.equal(flags.recorded, "/work/clone/tests/fixtures/audits");
  assert.equal(flags.config.browser.source, "recorded");
  assert.equal(flags.strictFake, true);
  assert.equal(flags.json, true);
  // The provider comes from LLM_PROVIDER when --llm is absent; --llm wins.
  assert.deepEqual(ok(["audit", "--src", "s"], { LLM_PROVIDER: "none" }).config.llm, { provider: "none" });
  assert.deepEqual(ok(["audit", "--src", "s", "--llm", "fake"], { LLM_PROVIDER: "none" }).config.llm.provider, "fake");
  assert.equal(ok(["audit", "--src", "s"], { A11Y_OUT: "elsewhere" }).config.out, "/work/clone/elsewhere");
  assert.equal(ok(["audit", "--src", "s", "--out", "flag"], { A11Y_OUT: "elsewhere" }).config.out, "/work/clone/flag");
});

test("[CLI-05] --repo-root defaults to A11Y_REPO_ROOT, then GITHUB_WORKSPACE, then cwd", () => {
  const argv = ["audit", "--src", "site"];
  assert.equal(ok(argv).config.repoRoot, "/work/clone");
  assert.equal(ok(argv, { GITHUB_WORKSPACE: "/github/ws" }).config.repoRoot, "/github/ws");
  assert.equal(ok(argv, { GITHUB_WORKSPACE: "/github/ws", A11Y_REPO_ROOT: "/mine" }).config.repoRoot, "/mine");
  assert.equal(ok([...argv, "--repo-root", "sub"], { GITHUB_WORKSPACE: "/github/ws", A11Y_REPO_ROOT: "/mine" }).config.repoRoot, "/work/clone/sub");
  assert.equal(ok(argv, { GITHUB_WORKSPACE: "", A11Y_REPO_ROOT: "" }).config.repoRoot, "/work/clone", "empty variables count as unset");
});

test("[CLI-02] the fail-on decision counts only violations in remainingInSource at or above the level", () => {
  const found = [finding("moderate", "violation"), finding("critical", "incomplete"), finding("minor", "violation")];
  assert.equal(failOnTriggered(found, "none"), false);
  assert.equal(failOnTriggered(found, "minor"), true);
  assert.equal(failOnTriggered(found, "moderate"), true);
  assert.equal(failOnTriggered(found, "serious"), false, "the critical item is a needs-review item and never fails a build (P-2)");
  assert.equal(failOnTriggered(found, "critical"), false);
  assert.equal(failOnTriggered([...found, finding("serious", "violation", "unreachable-control")], "serious"), true);
  assert.equal(failOnTriggered([], "minor"), false);
  assert.equal(ok(["audit", "--src", "s", "--fail-on", "serious"]).config.failOn, "serious");
  const bad = run(["audit", "--src", "s", "--fail-on", "severe"]);
  assert.equal(bad.kind === "error" && bad.code, "CONFIG_INVALID");
  assert.match(bad.kind === "error" ? bad.message : "", /--fail-on/);
});

test("[CS-10] --deadline 30 gives deadlineMs 30000, and --max-candidates 0 is rejected by the schema", () => {
  assert.equal(ok(["audit", "--src", "s", "--deadline", "30"]).config.deadlineMs, 30000);
  const zero = run(["audit", "--src", "s", "--max-candidates", "0"]);
  assert.equal(zero.kind === "error" && zero.code, "CONFIG_INVALID");
  assert.match(zero.kind === "error" ? zero.message : "", /^Invalid configuration: --max-candidates: /);
  const slow = run(["audit", "--src", "s", "--deadline", "5"]);
  assert.match(slow.kind === "error" ? slow.message : "", /^Invalid configuration: --deadline: /);
  const lang = run(["audit", "--src", "s", "--lang", "EN_us"]);
  assert.match(lang.kind === "error" ? lang.message : "", /^Invalid configuration: --lang: /);
  assert.equal(JSON.stringify(lang).includes("EN_us"), false, "no value is echoed");
  const page = run(["audit", "--src", "s", "--page", "pricing"]);
  assert.match(page.kind === "error" ? page.message : "", /^Invalid configuration: --page: /);
  const c = ok(["audit", "--src", "s", "--max-fixes", "0", "--max-llm-calls", "0", "--no-fix", "--no-sarif", "--write", "--allow-new-incomplete", "--lang", "pt-BR", "--page", "/pricing"]);
  assert.deepEqual(
    [c.config.maxFixes, c.config.maxLlmCalls, c.config.fix, c.config.sarif, c.config.write, c.config.allowNewIncomplete, c.config.lang, c.config.pagePath],
    [0, 0, false, false, true, true, "pt-BR", "/pricing"],
  );
  assert.equal(ok(["audit", "--src", "s"]).config.deadlineMs, 600000);
});

test("[CLI-01] LOG_LEVEL is validated", () => {
  assert.equal(ok(["audit", "--src", "s"]).logLevel, "info");
  assert.equal(ok(["audit", "--src", "s"], { LOG_LEVEL: "debug" }).logLevel, "debug");
  assert.equal(run(["audit", "--src", "s"], { LOG_LEVEL: "loud" }).kind, "error");
});

test("[CLI-01] main prints help and version on stdout with exit 0, and a usage error on stderr with exit 2, without a browser", async () => {
  const lines = { out: [] as string[], err: [] as string[] };
  const io = { stdout: (s: string) => void lines.out.push(s), stderr: (s: string) => void lines.err.push(s), cwd: process.cwd() };
  assert.equal(await main(["--help"], {}, io), 0);
  assert.equal(lines.out[0], HELP);
  assert.equal(await main(["--version"], {}, io), 0);
  assert.equal(lines.out[1], `${TOOL.name} ${TOOL.version}`);
  assert.equal(await main(["audit"], {}, io), 2);
  assert.deepEqual(lines.err, ["USAGE: Invalid usage: --src: required"]);
  assert.equal(await main(["audit", "--src", "fixtures/storefront", "--recorded", "does/not/exist"], {}, io), 2);
  assert.match(lines.err.at(-1)!, /^CONFIG_INVALID: Invalid configuration: --recorded: /);
  assert.equal(await main(["audit", "--src", "fixtures/storefront", "--llm-fixture", "nope.json", "--recorded", "tests/fixtures/audits"], {}, io), 2);
  assert.match(lines.err.at(-1)!, /^CONFIG_INVALID: Invalid configuration: --llm-fixture: /);
});
