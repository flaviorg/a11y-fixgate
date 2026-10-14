// A scripted AuditRunner (spec 4.2): returns the snapshot of the first case whose predicate matches the
// .html files of the served root. Counts audits and keeps the targets, so tests can prove caps and isolation.
import { readFileSync } from "node:fs";
import type { AuditSnapshot } from "../../src/contracts/snapshot.ts";
import type { AuditOptions, AuditRunner, AuditTarget } from "../../src/domain/ports.ts";
import { listRegularFiles } from "../../src/infra/tree-hash.ts";

export type ScriptedCase = { when: (files: Record<string, string>) => boolean; snapshot: AuditSnapshot };

export type ScriptedRunner = AuditRunner & {
  audits(): number;
  targets(): AuditTarget[];
  /** The .html files served by each audit, in order. */
  served(): Array<Record<string, string>>;
  options(): AuditOptions[];
};

export function htmlFilesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listRegularFiles(root, { maxFiles: 10_000 })) if (/\.html?$/i.test(f.rel)) out[f.rel] = readFileSync(f.abs, "utf8");
  return out;
}

export function scriptedRunner(cases: ScriptedCase[], hooks: { onAudit?: (target: AuditTarget) => void } = {}): ScriptedRunner {
  const targets: AuditTarget[] = [];
  const served: Array<Record<string, string>> = [];
  const options: AuditOptions[] = [];
  return {
    async audit(target: AuditTarget, _profile, opts: AuditOptions = {}): Promise<AuditSnapshot> {
      targets.push(target);
      options.push(opts);
      const files = htmlFilesOf(target.servedRoot);
      served.push(files);
      hooks.onAudit?.(target);
      const hit = cases.find((c) => c.when(files));
      if (!hit) throw new Error(`scriptedRunner: no case matches the served files (${Object.keys(files).join(", ")})`);
      return { ...structuredClone(hit.snapshot), url: target.url, pagePath: target.pagePath };
    },
    async close(): Promise<void> {},
    audits: () => targets.length,
    targets: () => [...targets],
    served: () => [...served],
    options: () => [...options],
  };
}
