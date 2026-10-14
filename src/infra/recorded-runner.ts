// Recorded audit runner (spec 4.2, AUD-06, P-7, P-8): serves snapshots recorded by npm run fixtures:record,
// looked up by the tree hash of the served root plus the sorted watch list.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { recordingFileSchema } from "../contracts/snapshot.ts";
import type { AuditProfile, AuditSnapshot } from "../contracts/snapshot.ts";
import { AppError } from "../domain/errors.ts";
import type { AuditRunner, AuditTarget } from "../domain/ports.ts";
import { treeSha256 } from "./tree-hash.ts";

/** sha256(treeSha + "\n" + sorted watch keys joined by ","), as hex. */
export function recordingKey(treeSha: string, watch: readonly string[]): string {
  return createHash("sha256").update(`${treeSha}\n${[...watch].sort().join(",")}`).digest("hex");
}

export function noRecordingMessage(treeSha: string, pagePath: string): string {
  return `No recorded audit for served tree sha256 ${treeSha.slice(0, 12)} (page ${pagePath}); run npm run fixtures:record (-- --check lists missing keys)`;
}

export type RecordedRunnerOptions = {
  /** Called on a miss instead of throwing NO_RECORDING (used by fixtures:record --check). */
  onMissing?: (key: string, target: AuditTarget) => AuditSnapshot;
};

export type RecordedRunner = AuditRunner & { lookups(): Array<{ key: string; hit: boolean }> };

/** Loads and validates every *.json recording in dir. The file name must be <scenario>.<first 12 hex of the key>.json. */
export function loadRecordingDir(dir: string): Map<string, { label: string; snapshot: AuditSnapshot }> {
  const byKey = new Map<string, { label: string; snapshot: AuditSnapshot }>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = recordingFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`Recording ${file} does not match the snapshot schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { recordingKey: key, label, snapshot } = parsed.data;
    if (!file.endsWith(`.${key.slice(0, 12)}.json`)) throw new Error(`Recording ${file}: the file name does not end with the first 12 characters of its key (${key.slice(0, 12)})`);
    byKey.set(key, { label, snapshot });
  }
  return byKey;
}

export function createRecordedRunner(dir: string, opts: RecordedRunnerOptions = {}): RecordedRunner {
  const recordings = loadRecordingDir(dir);
  const lookups: Array<{ key: string; hit: boolean }> = [];
  return {
    async audit(target: AuditTarget, _profile: AuditProfile): Promise<AuditSnapshot> {
      const tree = treeSha256(target.servedRoot);
      const key = recordingKey(tree, target.watch);
      const found = recordings.get(key);
      const hit = found !== undefined && found.snapshot.pagePath === target.pagePath;
      lookups.push({ key, hit });
      if (hit) return { ...structuredClone(found.snapshot), url: target.url }; // recordings store a placeholder URL
      if (opts.onMissing) return opts.onMissing(key, target);
      throw new AppError("NO_RECORDING", noRecordingMessage(tree, target.pagePath), { key });
    },
    async close(): Promise<void> {},
    lookups: () => lookups.map((l) => ({ ...l })),
  };
}
