// Ports of the domain. Only the types that exist so far; later tasks extend this file.
import type { LlmInput, LlmResult, LlmTaskName } from "../contracts/llm.ts";
import type { AuditProfile, AuditSnapshot } from "../contracts/snapshot.ts";

export type Clock = { now(): Date };

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

export interface StaticServerFactory {
  start(root: string): Promise<{ url: string; close(): Promise<void> }>;
}

/** A disposable copy of the source tree. Candidates are written and audited here, never in the source root. */
export type Scratch = {
  root: string;
  /** The .html and .htm texts, keyed by relative posix path. */
  files(): Record<string, string>;
  /** Writes (or replaces) files inside the copy only; keys are relative posix paths. */
  write(files: Record<string, string>): void;
  dispose(): void;
};

export interface ScratchFactory {
  /** excludeAbs: absolute paths (for example an --out directory inside the source root) left out of the copy. */
  create(sourceRoot: string, options?: { excludeAbs?: string[] }): Promise<Scratch>;
}

/**
 * One page to audit (spec 4.4). servedRoot is the directory the static server serves (the source root or a
 * scratch copy); the recorded runner hashes it. watch lists DOM node keys ("<tag>[<domTagIndex>]", spec 5.1)
 * whose aria snapshot is captured whether or not they are flagged; sorted; part of the recording key.
 */
export type AuditTarget = { url: string; servedRoot: string; pagePath: string; watch: string[] };

/** screenshot: file name under <outDir>/screenshots; without it (or without an out dir) no screenshot is taken. */
export type AuditOptions = { screenshot?: "page.png" | "page.after.png" };

export interface AuditRunner {
  /** Audits one page and returns everything the pipeline needs; never throws for findings, throws AppError for infrastructure. */
  audit(target: AuditTarget, profile: AuditProfile, opts?: AuditOptions): Promise<AuditSnapshot>;
  close(): Promise<void>;
}

/**
 * One provider call (spec 4.4). feedback is the rejection of attempt 1 (a value-gate reason, or the verdict
 * reasons with the new rule ids); it goes into the prompt but never into the fixture key.
 */
export type LlmCallContext = { requestId: string; signal: AbortSignal; attempt: 1 | 2; feedback: string | null };

export interface LlmProvider {
  readonly name: "fake" | "none" | "openai-compatible" | "anthropic";
  /** Resolves to { kind: "proposal", output } or { kind: "no-proposal", reason }; throws only for infrastructure errors (LlmUnavailableError, AppError). */
  complete<T extends LlmTaskName>(task: T, input: LlmInput<T>, ctx: LlmCallContext): Promise<LlmResult>;
}
