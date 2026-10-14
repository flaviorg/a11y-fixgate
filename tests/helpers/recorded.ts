// Access to the recorded audits under tests/fixtures/audits (P-7).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { recordingFileSchema } from "../../src/contracts/snapshot.ts";
import type { AuditSnapshot, RecordingFile } from "../../src/contracts/snapshot.ts";
import { AUDITS_DIR } from "./fixtures.ts";

/** Every recording file, parsed, sorted by file name. */
export function loadRecordings(): Array<{ file: string } & RecordingFile> {
  return readdirSync(AUDITS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...recordingFileSchema.parse(JSON.parse(readFileSync(join(AUDITS_DIR, file), "utf8"))) }));
}

/** The snapshot of the first recording with this label (for example "baseline"). */
export function loadRecording(label: string): AuditSnapshot {
  const found = loadRecordings().find((r) => r.label === label);
  if (!found) throw new Error(`no recording labelled ${label} in ${AUDITS_DIR}; run npm run fixtures:record`);
  return found.snapshot;
}

/**
 * Runs the whole pipeline of a recording scenario (scripts/record-audits.ts SCENARIOS) with the recorded
 * runner, the scenario's LLM provider and no output: what fixtures:record --check runs, quietly.
 */
export async function runAuditRecorded(scenario: string) {
  const { SCENARIOS, runScenarioPipeline } = await import("../../scripts/record-audits.ts");
  const { createRecordedRunner } = await import("../../src/infra/recorded-runner.ts");
  const found = SCENARIOS.find((s) => s.name === scenario);
  if (!found) throw new Error(`no recording scenario ${scenario}`);
  return runScenarioPipeline(found, createRecordedRunner(AUDITS_DIR), { executablePath: null, source: "recorded" }, { print: false });
}
