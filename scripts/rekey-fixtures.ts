// npm run fixtures:rekey [-- --print-inputs]  (spec 7.1, plan Task 28)
//
// Recomputes every response's key from its stored task and input, and every promptHashes entry from the
// current prompts, in fixtures/llm/*.json and tests/fixtures/llm/*.json. Prints each change; the Git diff is
// the review. --print-inputs maps the recorded storefront baseline and prints, for every finding with an LLM
// strategy, the task, the key and the canonical input, built by the same altTextInputFor/controlNameInputFor
// as the run; the fixture author pastes those inputs. Output goes to stderr: stdout is reserved for
// src/cli.ts and scripts/demo.ts.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { altTextInputFor, controlNameInputFor } from "../src/app/page-context.ts";
import { isUnmapped } from "../src/contracts/finding.ts";
import { DEFAULT_PROFILE } from "../src/contracts/snapshot.ts";
import { analyzeSnapshot } from "../src/domain/findings.ts";
import { strategiesFor } from "../src/domain/fix/catalog.ts";
import { createIdAllocator } from "../src/domain/fix/id-allocator.ts";
import type { FixContext } from "../src/domain/fix/types.ts";
import { buildHtmlIndex } from "../src/domain/map/html-index.ts";
import { loadRecordingDir, recordingKey } from "../src/infra/recorded-runner.ts";
import { readInsideRoot } from "../src/infra/safe-read.ts";
import { treeSha256 } from "../src/infra/tree-hash.ts";
import { canonicalJson, keyInputOf, llmKey, promptHash } from "../src/llm/fixture-format.ts";
import { PROMPTS } from "../src/llm/prompts/index.ts";

const PROJECT = join(import.meta.dirname, "..");
const STOREFRONT = join(PROJECT, "fixtures", "storefront");
const AUDITS_DIR = join(PROJECT, "tests", "fixtures", "audits");
export const FIXTURE_DIRS = [join(PROJECT, "fixtures", "llm"), join(PROJECT, "tests", "fixtures", "llm")];

const say = (line: string): void => void process.stderr.write(line + "\n");

type RawFixture = { promptHashes?: Record<string, string>; responses?: Array<{ key?: string; task?: string; label?: string; input?: unknown; attempt?: number }> };

/** Rekeys one parsed fixture in place; returns the change lines. */
export function rekey(fixture: RawFixture): string[] {
  const changes: string[] = [];
  const hashes: Record<string, string> = {};
  for (const prompt of Object.values(PROMPTS)) {
    hashes[prompt.name] = promptHash(prompt);
    if (fixture.promptHashes?.[prompt.name] !== hashes[prompt.name]) changes.push(`promptHash ${prompt.name} -> ${hashes[prompt.name]!.slice(7, 19)}`);
  }
  fixture.promptHashes = hashes;
  for (const r of fixture.responses ?? []) {
    if (r.task !== "alt-text" && r.task !== "control-name") continue;
    const key = llmKey(r.task, r.input);
    if (r.key !== key) changes.push(`key ${r.task} a${r.attempt ?? 1} "${r.label ?? ""}": ${(r.key ?? "none").slice(0, 12)} -> ${key.slice(0, 12)}`);
    r.key = key;
  }
  return changes;
}

function rekeyAll(): number {
  let changed = 0;
  for (const dir of FIXTURE_DIRS) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const fixture = JSON.parse(readFileSync(path, "utf8")) as RawFixture;
      const changes = rekey(fixture);
      if (changes.length === 0) {
        say(`same ${name}`);
        continue;
      }
      changed++;
      writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
      for (const c of changes) say(`${name}: ${c}`);
    }
  }
  say(`${changed} fixture file(s) changed`);
  return 0;
}

/** Prints the LLM inputs of the recorded storefront baseline (the baseline is audited on an identical copy, so its key is the source tree's). */
function printInputs(): number {
  const key = recordingKey(treeSha256(STOREFRONT), []);
  const recorded = loadRecordingDir(AUDITS_DIR).get(key);
  if (!recorded) {
    say(`no recorded storefront baseline (key ${key.slice(0, 12)}); run npm run fixtures:record`);
    return 1;
  }
  const html = readInsideRoot(STOREFRONT, "index.html").toString("utf8");
  const index = buildHtmlIndex({ "index.html": html });
  const snapshot = recorded.snapshot;
  const ids = createIdAllocator(index.files["index.html"]!.ids, snapshot.domIds);
  for (const finding of analyzeSnapshot(snapshot, index, "index.html", DEFAULT_PROFILE)) {
    if (finding.source !== "axe" || finding.status !== "violation" || isUnmapped(finding.location)) continue;
    const ctx: FixContext = { finding, location: finding.location, source: html, index, snapshot, config: { lang: "en", allowNewIncomplete: false }, ids };
    for (const strategy of strategiesFor(finding.ruleId)) {
      if (strategy.kind !== "llm") continue;
      const input = strategy.task === "alt-text" ? altTextInputFor(ctx, { sourceRoot: STOREFRONT, pagePath: "/", read: readInsideRoot }) : controlNameInputFor(ctx, strategy.role ?? "button");
      say(`${finding.id} ${strategy.task}${strategy.role ? ` (${strategy.role})` : ""} key ${llmKey(strategy.task, input)}`);
      say(canonicalJson(keyInputOf(input)));
    }
  }
  return 0;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "print-inputs": { type: "boolean", default: false } } });
  process.exitCode = values["print-inputs"] ? printInputs() : rekeyAll();
}
