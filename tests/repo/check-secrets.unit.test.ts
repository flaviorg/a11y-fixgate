// scripts/check-secrets.ts (plan Task 36; REP-04, REP-07): the scanner finds a key built at run time and never reports its value.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listProjectFiles, scanProject, scanText } from "../../scripts/check-secrets.ts";
import { tmpDir } from "../helpers/tmp.ts";

// Key-shaped values are built at run time so that this file never contains one.
const fakeKey = (): string => "sk-or-v1-" + "a".repeat(40);

test("[REP-07] check-secrets finds a key built at run time in a temp file and reports no value", (t) => {
  const root = tmpDir(t, "a11y-secrets-");
  writeFileSync(join(root, "notes.txt"), `fine line\nvalue = ${fakeKey()}\nanother fine line\n`);
  writeFileSync(join(root, "clean.txt"), "risk-assessment-framework-for-everyone\n");
  const { files, findings } = scanProject(root, { isTracked: () => false });
  assert.equal(files, 2);
  assert.deepEqual(findings, [{ path: "notes.txt", line: 2, pattern: "sk-or-v1- key" }]);
  assert.ok(!JSON.stringify(findings).includes("aaaaaaaa"), "the matched text is never part of a finding");
});

test("[REP-07] check-secrets knows the key shapes of spec 5.12 and a filled-in LLM_API_KEY line", () => {
  const cases: Array<[string, string]> = [
    ["sk-ant- key", "sk-ant-" + "b".repeat(30)],
    ["sk- key", "sk-" + "c".repeat(24)],
    ["AIza key", "AIza" + "d".repeat(35)],
    ["LLM_API_KEY with a value", "LLM_API_KEY=" + "not-a-real-value"],
  ];
  for (const [pattern, line] of cases) assert.deepEqual(scanText(line, "x"), [{ path: "x", line: 1, pattern }], pattern);
  assert.deepEqual(scanText("LLM_API_KEY=\n# LLM_API_KEY=\nexport LLM_API_KEY from your shell\n", "x"), []);
});

test("[REP-07] check-secrets skips node_modules, .git, reports, coverage, binary files, and an untracked .env", (t) => {
  const root = tmpDir(t, "a11y-secrets-");
  for (const dir of ["node_modules/pkg", ".git", "reports/latest", "coverage"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "f.txt"), fakeKey());
  }
  writeFileSync(join(root, "image.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fakeKey())]));
  writeFileSync(join(root, ".env"), "LLM_API_KEY=" + "x".repeat(20) + "\n");
  writeFileSync(join(root, "keep.txt"), "hello\n");
  assert.deepEqual(listProjectFiles(root, { isTracked: () => false }).map((f) => f.slice(root.length + 1)), ["keep.txt"]);
  // A tracked .env is scanned.
  assert.deepEqual(listProjectFiles(root, { isTracked: (rel) => rel === ".env" }).map((f) => f.slice(root.length + 1)), [".env", "keep.txt"]);
  assert.equal(scanProject(root, { isTracked: (rel) => rel === ".env" }).findings.length, 1);
});
