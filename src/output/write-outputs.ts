// Writes the four output files into --out (spec 5.8). Screenshots were already written by the runner.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditResult } from "../contracts/result.ts";
import { redactText } from "../infra/redact.ts";
import { toAuditJson } from "./audit-json.ts";
import { fixesPatchText } from "./patch-file.ts";
import type { PatchInput } from "./patch-file.ts";
import { renderReport } from "./report-html.ts";
import { toSarif } from "./sarif.ts";

export type WriteOutputsOptions = { outDir: string; sourceRoot: string; repoRoot: string; sarif: boolean };

/**
 * report.html and audit.json always; fixes.patch when a fix is included (P-11), or fixes.rejected.patch when the
 * combined audit disagreed with the per-fix verdicts; results.sarif unless --no-sarif. Files from an earlier run
 * that this run does not produce are removed, so an old patch or SARIF is never mistaken for this run's.
 * Returns the file names written, relative to outDir.
 */
export function writeOutputs(result: AuditResult & PatchInput, { outDir, sourceRoot, repoRoot, sarif }: WriteOutputsOptions): { written: string[] } {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, text: string): void => {
    writeFileSync(join(outDir, name), redactText(text), "utf8");
    written.push(name);
  };

  put("report.html", renderReport(result));

  const patch = fixesPatchText(result, sourceRoot, repoRoot);
  const mismatch = result.warnings.some((w) => w.startsWith("combined-audit-mismatch:"));
  const patchName = mismatch ? "fixes.rejected.patch" : "fixes.patch";
  const otherName = mismatch ? "fixes.patch" : "fixes.rejected.patch";
  rmSync(join(outDir, otherName), { force: true });
  if (patch !== null) put(patchName, patch);
  else rmSync(join(outDir, patchName), { force: true });

  if (sarif) put("results.sarif", JSON.stringify(toSarif(result, { sourceRoot, repoRoot }), null, 2) + "\n");
  else rmSync(join(outDir, "results.sarif"), { force: true });

  put("audit.json", toAuditJson(result, { sourceRoot, repoRoot }));
  return { written };
}
