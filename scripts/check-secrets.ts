// npm run check:secrets (spec 6.2 item 10; REP-04, REP-07): scans the project tree for key-shaped strings and for a
// filled-in LLM_API_KEY assignment. Never prints a value: only path, line and the name of the pattern.
// It runs in the pre-commit hook and in CI. Git is asked only whether a local .env file is tracked.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writeErr, writeOut } from "../src/infra/write-out.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");

/**
 * The key patterns of spec 5.12 (the lookbehind keeps ordinary words such as "risk-assessment-..." out), plus an
 * LLM_API_KEY assignment with a value at the start of a line. A pattern is a regex literal with no run of key
 * characters in it, so this file never matches itself.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "sk-or-v1- key", re: /(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{16,}/ },
  { name: "sk-ant- key", re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: "sk- key", re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/ },
  { name: "AIza key", re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/ },
  { name: "LLM_API_KEY with a value", re: /^\s*LLM_API_KEY=\S+/ },
];

export type SecretFinding = { path: string; line: number; pattern: string };

/** At most one finding per line (the most specific pattern wins, since "sk-" also matches the longer prefixes). The matched text is never part of a finding. */
export function scanText(text: string, path: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((content, i) => {
    const hit = SECRET_PATTERNS.find(({ re }) => re.test(content));
    if (hit) found.push({ path, line: i + 1, pattern: hit.name });
  });
  return found;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "reports", "coverage"]);

export type ScanOptions = {
  /** True when Git tracks this relative path. Default: `git ls-files --error-unmatch`. Only a local .env needs it. */
  isTracked?: (rel: string) => boolean;
};

function trackedByGit(root: string, rel: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root, stdio: "ignore" }).status === 0;
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Absolute paths of the text files to scan: no node_modules, .git, reports or coverage, no binary file, and a local .env only when Git tracks it. */
export function listProjectFiles(root: string, opts: ScanOptions = {}): string[] {
  const isTracked = opts.isTracked ?? ((rel: string) => trackedByGit(root, rel));
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) visit(abs);
      } else if (stat.isFile() && !looksBinary(abs)) {
        if (name === ".env" && !isTracked(rel)) continue;
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

export type ScanResult = { files: number; findings: SecretFinding[] };

export function scanProject(root: string = PROJECT_ROOT, opts: ScanOptions = {}): ScanResult {
  const files = listProjectFiles(root, opts);
  const findings = files.flatMap((abs) => scanText(readFileSync(abs, "utf8"), relative(root, abs).split(sep).join("/")));
  return { files: files.length, findings };
}

if (import.meta.main) {
  const { files, findings } = scanProject();
  if (findings.length === 0) {
    writeOut(`check:secrets: no secrets in ${files} text file(s)`);
  } else {
    for (const f of findings) writeErr(`check:secrets: ${f.path}:${f.line} looks like a ${f.pattern} (value not shown)`);
    writeErr(`check:secrets: ${findings.length} finding(s) in ${files} text file(s)`);
    process.exitCode = 1;
  }
}
