import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { builtinModules } from "node:module";
import { ENV_KEYS } from "../../src/contracts/config.ts";
import { TOOL } from "../../src/contracts/tool.ts";
import { scanText } from "../../scripts/check-secrets.ts";
import { PROJECT_ROOT, codeLines, importSpecifiers, listRepoFiles, readRepoFile, resolveImport, stdoutLines, stripComments } from "../helpers/repo-files.ts";

const files = listRepoFiles();
const PROJECT_ROOTED = PROJECT_ROOT;
const sourceFiles = (prefix: string) => files.filter((f) => f.startsWith(prefix) && f.endsWith(".ts"));
const NODE_BUILTINS = new Set(builtinModules);
const isNodeBuiltin = (spec: string) => spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]!);
const specsOf = (rel: string, opts?: { includeTypeOnly?: boolean }) => importSpecifiers(readRepoFile(rel), opts);
const violations = (found: string[]) => assert.deepEqual(found, [], `violations:\n${found.join("\n")}`);

test("[REP-05] scanners find static, re-export and dynamic imports and console writes", () => {
  const src = [
    'import a from "node:fs";',
    'import type { B } from "./b.ts";',
    'import { c } from "../c.ts"',
    'export * from "./d.ts";',
    'export type { E } from "./e.ts";',
    'import "side-effect";',
    "import {",
    "  f,",
    '} from "multi-line";',
    'const lazy = await import("./lazy.ts");',
    '// import nope from "commented";',
    ' * import nope2 from "block-comment";',
    'const text = "http://example.test/import x from \'y\'";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(src), ["node:fs", "./b.ts", "../c.ts", "./d.ts", "./e.ts", "side-effect", "multi-line", "./lazy.ts"]);
  assert.deepEqual(importSpecifiers(src, { includeTypeOnly: false }), ["node:fs", "../c.ts", "./d.ts", "side-effect", "multi-line", "./lazy.ts"]);
  assert.equal(resolveImport("src/domain/fix/gates.ts", "../errors.ts"), "src/domain/errors.ts");
  assert.equal(resolveImport("src/cli.ts", "./app/run-audit.ts"), "src/app/run-audit.ts");
  assert.equal(resolveImport("src/cli.ts", "zod"), "zod");
  assert.equal(resolveImport("src/cli.ts", "node:fs"), "node:fs");
  const consoleSrc = ['console.log("a");', "  console.info('b')", "console.error('c');", "// console.log('commented')", "/* console.debug('x') */", "console.debug(1)"].join("\n");
  assert.deepEqual(stdoutLines(consoleSrc), [1, 2, 6]);
  assert.deepEqual(codeLines("const a = process.env.X;\n// process.env.Y", /\bprocess\.env\b/), [1]);
});

test("[REP-05] src/contracts and src/domain import no node:*, playwright-core, runtime axe-core, or src/browser|infra|llm|app|output|cli", () => {
  const forbiddenLayers = ["src/browser/", "src/infra/", "src/llm/", "src/app/", "src/output/", "src/cli.ts"];
  const found: string[] = [];
  for (const rel of [...sourceFiles("src/contracts/"), ...sourceFiles("src/domain/")]) {
    for (const spec of specsOf(rel)) {
      if (isNodeBuiltin(spec)) found.push(`${rel}: ${spec} (node builtin)`);
      if (spec === "playwright-core") found.push(`${rel}: ${spec}`);
      const target = resolveImport(rel, spec);
      if (spec.startsWith(".") && forbiddenLayers.some((l) => target === l || target.startsWith(l))) found.push(`${rel}: ${spec} (layer)`);
    }
    for (const spec of specsOf(rel, { includeTypeOnly: false })) if (spec === "axe-core") found.push(`${rel}: runtime axe-core`);
  }
  violations(found);
});

test("[REP-05] only src/browser imports playwright-core and only src/browser/axe-config.ts imports axe-core at run time", () => {
  const found: string[] = [];
  for (const rel of sourceFiles("src/")) {
    if (specsOf(rel).includes("playwright-core") && !rel.startsWith("src/browser/")) found.push(`${rel}: playwright-core`);
    if (specsOf(rel, { includeTypeOnly: false }).includes("axe-core") && rel !== "src/browser/axe-config.ts") found.push(`${rel}: runtime axe-core`);
  }
  violations(found);
});

test("[REP-05] only src/llm/openai-compatible.ts calls fetch(", () => {
  const found = sourceFiles("src/")
    .filter((rel) => rel !== "src/llm/openai-compatible.ts")
    .flatMap((rel) => codeLines(readRepoFile(rel), /\bfetch\s*\(/).map((n) => `${rel}:${n}`));
  violations(found);
});

test("[REP-05] only src/cli.ts, scripts and tests read process.env", () => {
  const found = sourceFiles("src/")
    .filter((rel) => rel !== "src/cli.ts")
    .flatMap((rel) => codeLines(readRepoFile(rel), /\bprocess\s*\.\s*env\b/).map((n) => `${rel}:${n}`));
  violations(found);
});

test("[REP-05] src has no console.log, console.info or console.debug, and stdout is written only by src/cli.ts through src/infra/write-out.ts", () => {
  const consoleHits = sourceFiles("src/").flatMap((rel) => stdoutLines(readRepoFile(rel)).map((n) => `${rel}:${n}`));
  violations(consoleHits);
  const stdoutHits = sourceFiles("src/")
    .filter((rel) => rel !== "src/cli.ts" && rel !== "src/infra/write-out.ts")
    .flatMap((rel) => codeLines(readRepoFile(rel), /\bprocess\s*\.\s*stdout\b/).map((n) => `${rel}:${n}`));
  violations(stdoutHits);
  // writeOut is the redacting door to stdout; only the CLI (and scripts/demo.ts) may call it.
  const callers = sourceFiles("src/").filter((rel) => rel !== "src/cli.ts" && rel !== "src/infra/write-out.ts" && /\bwriteOut\s*\(/.test(stripComments(readRepoFile(rel))));
  violations(callers);
});

test("[REP-05] relative imports end in .ts and zod is imported as a namespace", () => {
  const found: string[] = [];
  for (const rel of files.filter((f) => /^(src|tests|scripts)\/.*\.ts$/.test(f))) {
    for (const spec of specsOf(rel)) if (spec.startsWith(".") && !spec.endsWith(".ts")) found.push(`${rel}: ${spec}`);
    const code = readRepoFile(rel);
    if (/from\s+["']zod["']/.test(code) && !/import\s+\*\s+as\s+z\s+from\s+["']zod["']/.test(code)) found.push(`${rel}: zod must be imported as "import * as z from \\"zod\\""`);
  }
  violations(found);
});

test("[REP-05] src and scripts use only erasable syntax (no enum, namespace, parameter properties or decorators)", () => {
  const found: string[] = [];
  for (const rel of files.filter((f) => /^(src|scripts)\/.*\.ts$/.test(f))) {
    const lines = readRepoFile(rel).split("\n");
    const code = stripComments(lines.join("\n")).split("\n");
    code.forEach((line, i) => {
      if (/^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+\w+/.test(line)) found.push(`${rel}:${i + 1}: enum`);
      if (/^\s*(export\s+)?(declare\s+)?namespace\s+\w+/.test(line)) found.push(`${rel}:${i + 1}: namespace`);
      if (/^\s*@\w+/.test(line)) found.push(`${rel}:${i + 1}: decorator`);
      if (/\bconstructor\s*\([^)]*\b(public|private|protected|readonly)\s+\w+/.test(line)) found.push(`${rel}:${i + 1}: parameter property`);
    });
  }
  violations(found);
});

test("[P-6] package.json has no bin field and its version equals TOOL.version", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));
  assert.equal("bin" in pkg, false);
  assert.equal(pkg.version, TOOL.version);
  assert.equal(pkg.name, TOOL.name);
});

test("[P-6] package.json pins exactly five runtime dependencies and two dev dependencies, with exact versions", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));
  assert.deepEqual(pkg.dependencies, { "axe-core": "4.14.0", diff: "9.0.0", parse5: "8.0.1", "playwright-core": "1.64.0", zod: "4.6.5" });
  assert.deepEqual(pkg.devDependencies, { "@types/node": "26.6.4", typescript: "7.0.2" });
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.engines, { node: ">=24.21" });
  assert.equal(readRepoFile(".nvmrc").trim(), "24.21");
  assert.deepEqual(readRepoFile(".npmrc").trim().split("\n").sort(), ["engine-strict=true", "save-exact=true"]);
});

test("[P-6] package.json scripts are the ones of spec 4.7", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));
  assert.deepEqual(Object.keys(pkg.scripts).sort(), [
    "audit", "browser:install", "check:secrets", "demo", "fixtures:record", "fixtures:rekey", "setup:hooks", "test", "test:coverage", "test:e2e", "test:live", "test:unit", "typecheck", "verify",
  ]);
  assert.match(pkg.scripts.test, /--import \.\/tests\/setup\/no-network\.ts --test/);
  assert.match(pkg.scripts["test:unit"], /--import \.\/tests\/setup\/no-network\.ts/);
});

test("[REP-05] the rule tests see real files: the scan covers the contracts, the domain and the infra layers", () => {
  assert.ok(sourceFiles("src/contracts/").length >= 8, "contracts scanned");
  assert.ok(sourceFiles("src/domain/").length >= 2, "domain scanned");
  assert.ok(sourceFiles("src/infra/").length >= 8, "infra scanned");
  assert.ok(files.includes("package.json") && !files.some((f) => f.startsWith("node_modules/")));
});

// ---- Repository hygiene (plan Tasks 35 and 36) -------------------------------------------------------------------

/** EARS IDs proven outside `npm test` (spec 8.2): the ID must appear in the named file. */
const ALLOWLIST = { "REP-04": ".githooks/pre-commit", "LLM-08": "tests/live/llm.live.ts" } as const;

test("[REP-06] every EARS id in specs/*/spec.md appears as [ID] in a test name or in its allowlisted file", () => {
  const specFiles = files.filter((f) => /^specs\/\d{3}-[^/]+\/spec\.md$/.test(f));
  assert.equal(specFiles.length, 4);
  const ids = [...new Set(specFiles.flatMap((f) => [...readRepoFile(f).matchAll(/\*\*([A-Z]{3}-\d{2})\*\*/g)].map((m) => m[1]!)))];
  assert.equal(ids.length, 67); // AUD 10, KBD 4, MAP 5, FIX 10, VER 8, LLM 10, OUT 7, CLI 5, REP 8
  const testText = files.filter((f) => f.startsWith("tests/") && f.endsWith(".test.ts")).map(readRepoFile).join("\n");
  const missing = ids.filter((id) => {
    const alt = ALLOWLIST[id as keyof typeof ALLOWLIST];
    return alt ? !readRepoFile(alt).includes(`[${id}]`) : !testText.includes(`[${id}]`);
  });
  assert.deepEqual(missing, []);
});

test("[REP-06] each feature spec lists only the IDs of its own families, once, with a context, non-goals, questions and a checklist", () => {
  const families: Record<string, string[]> = {
    "specs/001-audit-and-keyboard/spec.md": ["AUD", "KBD"],
    "specs/002-source-mapping-and-fixes/spec.md": ["MAP", "FIX"],
    "specs/003-verification-loop-and-llm/spec.md": ["VER", "LLM"],
    "specs/004-outputs-and-cli/spec.md": ["OUT", "CLI", "REP"],
  };
  for (const [file, prefixes] of Object.entries(families)) {
    const text = readRepoFile(file);
    const ids = [...text.matchAll(/^- \*\*([A-Z]{3}-\d{2})\*\* /gm)].map((m) => m[1]!);
    assert.equal(new Set(ids).size, ids.length, `${file}: an ID is listed twice`);
    assert.ok(ids.every((id) => prefixes.includes(id.slice(0, 3))), `${file}: ${ids.join(", ")}`);
    for (const heading of ["## Context", "## Acceptance criteria", "## Non-goals", "## Questions resolved", "## Checklist"]) assert.ok(text.includes(heading), `${file}: ${heading}`);
  }
  const constitution = readRepoFile("specs/constitution.md");
  assert.ok(constitution.split("\n").length <= 60, "constitution.md has at most 60 lines");
});

test("[REP-01] AGENTS.md has at most 100 lines", () => {
  assert.ok(readRepoFile("AGENTS.md").split("\n").length <= 100);
});

test("[REP-02] .env.example lists every variable read by the config schema", () => {
  const env = readRepoFile(".env.example");
  assert.deepEqual(ENV_KEYS.filter((k) => !new RegExp(`^#?\\s*${k}=`, "m").test(env)), []);
  assert.match(env, /^LLM_API_KEY=$/m, "LLM_API_KEY is listed with no value");
  assert.match(env, /^# A11Y_BROWSER_PATH=.*chrome-headless-shell/m, "the puppeteer headless shell path is a commented example");
});

test("[P-6] LICENSE is MIT and NOTICE names axe-core MPL-2.0", () => {
  const license = readRepoFile("LICENSE");
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 Flavio Gouveia/);
  const notice = readRepoFile("NOTICE");
  assert.match(notice, /axe-core/);
  assert.match(notice, /MPL-2\.0/);
  assert.match(notice, /unmodified/i);
  for (const dep of ["playwright-core", "parse5", "diff", "zod"]) assert.ok(notice.includes(dep), `NOTICE names ${dep}`);
});

test("[REP-04] .githooks/pre-commit exists, is executable and runs typecheck, test:unit and check:secrets", () => {
  const hook = readRepoFile(".githooks/pre-commit");
  assert.match(hook, /^#!\/bin\/sh/);
  assert.match(hook, /^set -e$/m);
  assert.ok(statSync(`${PROJECT_ROOTED}/.githooks/pre-commit`).mode & 0o111, "the hook is executable");
  for (const script of ["typecheck", "test:unit", "check:secrets"]) assert.match(hook, new RegExp(`npm run --silent ${script}`));
  assert.ok(hook.includes("[REP-04]"));
});

/**
 * Paths excluded from the pending-marker scan (spec 8.2), plus the spec that quotes the REP-07 criterion verbatim:
 * its text has to name the markers.
 */
const SCAN_EXCLUDED = (rel: string): boolean =>
  rel === "tests/repo/conventions.unit.test.ts" || rel === "docs/standards-and-law.md" || rel === "specs/004-outputs-and-cli/spec.md" || rel.startsWith("docs/superpowers/");

test("[REP-07] no versioned file outside the excluded paths contains a pending marker or a key-shaped string", () => {
  const markers = new RegExp(`\\b(${"TO" + "DO"}|${"TB" + "D"})\\b`);
  const found: string[] = [];
  for (const rel of files.filter((f) => !SCAN_EXCLUDED(f))) {
    const text = readRepoFile(rel);
    text.split("\n").forEach((line, i) => {
      if (markers.test(line)) found.push(`${rel}:${i + 1}: pending marker`);
    });
    for (const hit of scanText(text, rel)) found.push(`${hit.path}:${hit.line}: ${hit.pattern}`);
  }
  assert.deepEqual(found, []);
});

test("[REP-07] README.md contains no phrase from the Appendix B forbidden list", () => {
  const phrases = [
    ["WCAG", " compliant"], ["fully", " compliant"], ["EAA", " compliant"], ["LBI", " compliant"], ["fixes", " all"], ["first", " tool"],
    ["proves", " every fix"], ["existing", " tools report"], ["overlays", " got an FTC order"], ["overlays", " patch"], ["nothing", " else broke"],
    ["nothing", " new appeared"], ["no new", " failure appeared"], ["break", " something else"], ["not affiliated", " with Evinced"],
  ].map((parts) => parts.join(""));
  const readme = readRepoFile("README.md").toLowerCase();
  assert.deepEqual(phrases.filter((p) => readme.includes(p.toLowerCase())), []);
});

/**
 * Unquoted node labels of the flowcharts in a Markdown file: `ID[text]`, `ID(text)`, `ID{text}` and their double
 * forms. Quoted strings are blanked first, so a quoted label that contains brackets is never a match.
 */
function unquotedMermaidLabels(markdown: string): string[] {
  const bad: string[] = [];
  for (const block of markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    const body = block[1]!.replace(/"[^"\n]*"/g, '"');
    if (!/^\s*(flowchart|graph)\b/m.test(body)) continue;
    for (const m of body.matchAll(/\b[A-Za-z][\w-]*(?:\[\[|\[|\(\(|\(|\{)[^\]\)\}"\n]+(?:\]\]|\]|\)\)|\)|\})/g)) bad.push(m[0]);
  }
  return bad;
}

test("[REP-07] the Mermaid scanner flags an unquoted flowchart label and accepts a quoted one", () => {
  assert.deepEqual(unquotedMermaidLabels("```mermaid\nflowchart LR\n  A[report/json] --> B\n```"), ["A[report/json]"]);
  assert.deepEqual(unquotedMermaidLabels('```mermaid\nflowchart LR\n  A["report/json (v1)"] --> B["ok"]\n```'), []);
});

test("[REP-07] every Mermaid flowchart node label in README.md and docs/**/*.md is quoted", () => {
  const found: string[] = [];
  for (const rel of files.filter((f) => f === "README.md" || (f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/superpowers/")))) {
    for (const label of unquotedMermaidLabels(readRepoFile(rel))) found.push(`${rel}: ${label}`);
  }
  assert.deepEqual(found, []);
});

test("[REP-07] sequence diagrams keep / and ( out of participant aliases", () => {
  const found: string[] = [];
  for (const rel of files.filter((f) => f === "README.md" || (f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/superpowers/")))) {
    for (const block of readRepoFile(rel).matchAll(/```mermaid\n([\s\S]*?)```/g)) {
      if (!/^\s*sequenceDiagram/m.test(block[1]!)) continue;
      for (const m of block[1]!.matchAll(/^\s*(?:participant|actor)\s+\w+\s+as\s+(.+)$/gm)) if (/[/(]/.test(m[1]!)) found.push(`${rel}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(found, []);
});
