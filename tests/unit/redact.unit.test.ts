import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactText } from "../../src/infra/redact.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { steppingClock, systemClock } from "../../src/infra/clock.ts";
import { AppError, EXIT_CODE_OF } from "../../src/domain/errors.ts";

// Key-shaped values are built at run time so no literal looks like a real key.
const skOrV1 = "sk-or-v1-" + "a".repeat(40);
const skAnt = "sk-ant-" + "b".repeat(30);
const sk = "sk-" + "c".repeat(30);
const aiza = "AIza" + "d".repeat(35);

test("[CLI-04] redactSecrets masks apiKey, authorization and LLM_API_KEY at any depth", () => {
  const input = {
    apiKey: "secret-1",
    nested: { Authorization: "Bearer secret-2", deeper: [{ LLM_API_KEY: "secret-3", keep: "visible" }] },
    llm_api_key: "secret-4",
    keep: 1,
  };
  assert.deepEqual(redactSecrets(input), {
    apiKey: "[REDACTED]",
    nested: { Authorization: "[REDACTED]", deeper: [{ LLM_API_KEY: "[REDACTED]", keep: "visible" }] },
    llm_api_key: "[REDACTED]",
    keep: 1,
  });
  assert.equal(input.apiKey, "secret-1", "the input is not mutated");
});

test("[CLI-04] redactSecrets masks the four key patterns inside strings and arrays", () => {
  const out = redactSecrets({
    text: `a ${skOrV1} b ${skAnt} c ${sk} d ${aiza} e`,
    list: [`key=${skOrV1}`, ["x", `${aiza}!`]],
  }) as { text: string; list: [string, [string, string]] };
  assert.equal(out.text, "a <redacted:sk-or-v1-> b <redacted:sk-ant-> c <redacted:sk-> d <redacted:AIza> e");
  assert.equal(out.list[0], "key=<redacted:sk-or-v1->");
  assert.deepEqual(out.list[1], ["x", "<redacted:AIza>!"]);
  assert.equal(redactText(`token ${sk}`), "token <redacted:sk->");
});

test("[CLI-04] redactSecrets leaves ordinary words that merely contain sk- alone", () => {
  assert.equal(redactText("risk-assessment-framework-for-everyone"), "risk-assessment-framework-for-everyone");
  assert.equal(redactText("short sk-abc"), "short sk-abc");
});

test("[CLI-04] redactSecrets handles errors, cycles and non-plain values without throwing", () => {
  const err = new Error(`failed with ${sk}`);
  const cyc: Record<string, unknown> = { name: "loop" };
  cyc["self"] = cyc;
  const out = redactSecrets({ err, cyc, n: null, u: undefined, b: true }) as Record<string, any>;
  assert.equal(out["err"].message, "failed with <redacted:sk->");
  assert.equal(out["err"].stack, undefined);
  assert.equal(out["cyc"].self, "[Circular]");
  assert.equal(out["n"], null);
  assert.equal(out["b"], true);
});

test("[CLI-04] logger writes one redacted JSON line with ts, level, component and event, and drops events below the level", () => {
  const lines: string[] = [];
  const clock = steppingClock("2026-10-08T12:00:00.000Z");
  const log = createLogger({ component: "loop", level: "info", write: (l) => lines.push(l), clock });
  log.debug("hidden", { a: 1 });
  log.info("candidate_verdict", { findingId: "link-name-2", apiKey: "topsecret", note: `x ${skOrV1}`, ts: "forged", long: "z".repeat(900) });
  clock.advance(900);
  log.warn("limit_hit", { limit: "max-llm-calls", value: 40 });
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!);
  assert.deepEqual(Object.keys(first).slice(0, 4), ["ts", "level", "component", "event"]);
  assert.equal(first.ts, "2026-10-08T12:00:00.000Z");
  assert.equal(first.level, "info");
  assert.equal(first.component, "loop");
  assert.equal(first.event, "candidate_verdict");
  assert.equal(first.apiKey, "[REDACTED]");
  assert.equal(first.note, "x <redacted:sk-or-v1->");
  assert.equal(first.long.length, 500);
  assert.ok(!lines[0]!.includes("\n"), "one line per event");
  const second = JSON.parse(lines[1]!);
  assert.equal(second.ts, "2026-10-08T12:00:00.900Z");
  assert.equal(second.level, "warn");
});

test("[CLI-04] logger child() adds fields and error level always passes", () => {
  const lines: string[] = [];
  const log = createLogger({ component: "llm", level: "error", write: (l) => lines.push(l) }).child({ requestId: "r1" });
  log.warn("dropped");
  log.error("call_failed", { kind: "timeout" });
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.requestId, "r1");
  assert.equal(rec.kind, "timeout");
  assert.equal(rec.component, "llm");
});

test("[CLI-04] logger child({ component }) switches the component of its lines (spec 5.12 components)", () => {
  const lines: string[] = [];
  const root = createLogger({ component: "cli", level: "info", write: (l) => lines.push(l) });
  root.child({ component: "loop" }).child({ component: "llm", requestId: "r2" }).info("call");
  root.info("done");
  assert.deepEqual(lines.map((l) => [JSON.parse(l).component, JSON.parse(l).requestId ?? null]), [["llm", "r2"], ["cli", null]]);
});

test("[CLI-01] every error code maps to the exit code of spec 5.10", () => {
  assert.deepEqual(
    { ...EXIT_CODE_OF },
    {
      USAGE: 2, CONFIG_INVALID: 2, NO_BROWSER: 3, PAGE_LOAD_FAILED: 4, AXE_VERSION_MISMATCH: 4, SRC_TOO_LARGE: 4,
      NO_RECORDING: 4, COMBINED_MISMATCH: 1, LLM_UNAVAILABLE: 5, UNSCRIPTED_LLM_CALL: 4, UNSAFE_PATH: 4,
      FIXTURE_PROMPT_DRIFT: 4, BOUNDED_PATCH: 4,
    },
  );
});

test("[CLI-01] AppError carries code, message and details", () => {
  const e = new AppError("UNSAFE_PATH", "Refused to read or write a.html: outside the source root or a symbolic link", { rel: "a.html" });
  assert.ok(e instanceof Error);
  assert.equal(e.name, "AppError");
  assert.equal(e.code, "UNSAFE_PATH");
  assert.deepEqual(e.details, { rel: "a.html" });
  assert.equal(new AppError("USAGE", "x").details, undefined);
});

test("[CLI-04] steppingClock advances only when asked and systemClock returns a Date", () => {
  const c = steppingClock("2026-01-01T00:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(c.now().toISOString(), "2026-01-01T00:00:00.000Z");
  c.advance(1500);
  assert.equal(c.now().toISOString(), "2026-01-01T00:00:01.500Z");
  assert.ok(systemClock.now() instanceof Date);
});
