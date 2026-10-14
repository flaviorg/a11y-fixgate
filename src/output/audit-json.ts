// audit.json (spec 5.8, OUT-04): the AuditResult with schemaVersion 1, stable key order, relative paths only, no secret.
import { relative, resolve } from "node:path";
import type { AuditConfig } from "../contracts/config.ts";
import { auditJsonSchema } from "../contracts/result.ts";
import type { AuditResult } from "../contracts/result.ts";
import { redactSecrets } from "../infra/redact.ts";
import { toPosix } from "../infra/paths.ts";

/** The config as audit.json shows it: paths relative to the repository root, no executable path, the API key masked. */
export function publicConfig(config: AuditConfig, repoRoot: string): AuditConfig {
  const rel = (p: string): string => toPosix(relative(repoRoot, resolve(p))) || ".";
  const llm: AuditConfig["llm"] =
    config.llm.provider === "fake"
      ? { ...config.llm, fixture: config.llm.fixture === null ? null : rel(config.llm.fixture) }
      : config.llm.provider === "openai-compatible"
        ? { ...config.llm, apiKey: "[REDACTED]", baseUrl: stripCredentials(config.llm.baseUrl) }
        : config.llm;
  return {
    ...config,
    sourceRoot: rel(config.sourceRoot),
    out: rel(config.out),
    repoRoot: config.repoRoot === null ? null : rel(config.repoRoot),
    browser: { executablePath: null, source: config.browser.source },
    llm,
  };
}

function stripCredentials(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** Recursively sorts the keys of plain objects; arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The text of audit.json. Only the AuditResult fields are written: an AuditRun's diffs and file contents are left
 * out. Throws if the result does not match the contract (a programming error, never a user error).
 */
export function toAuditJson(result: AuditResult, { sourceRoot, repoRoot }: { sourceRoot: string; repoRoot: string }): string {
  const plain: AuditResult = {
    config: publicConfig(result.config, repoRoot),
    baseline: result.baseline,
    findings: result.findings,
    outcomes: result.outcomes,
    combined: result.combined,
    summary: result.summary,
    timings: result.timings,
    limits: result.limits,
    llm: result.llm,
    warnings: result.warnings,
    written: result.written,
  };
  const withVersion = auditJsonSchema.parse({ schemaVersion: 1, ...plain });
  let text = JSON.stringify(sortKeys(redactSecrets(withVersion)), null, 2);
  // Defense in depth: an absolute path of this machine must not leave the process, wherever it came from.
  for (const abs of [resolve(sourceRoot), resolve(repoRoot), resolve(result.config.out)].sort((a, b) => b.length - a.length)) {
    if (abs.length > 1) text = text.split(JSON.stringify(abs).slice(1, -1)).join(".");
  }
  return text + "\n";
}
