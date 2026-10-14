// The none provider and the provider factory (spec 7.1; LLM-10).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AltTextInput, ControlNameInput } from "../../src/contracts/llm.ts";
import { createLlmProvider, bundledFixturePath } from "../../src/llm/provider.ts";
import { noneProvider } from "../../src/llm/none-provider.ts";

const altInput: AltTextInput = { pageTitle: "Shop", src: "images/x.png", surroundingText: "", insideControl: false, image: null };
const nameInput: ControlNameInput = { role: "button", html: "<button>", surroundingText: "", href: null, placeholder: null, iconHints: [], pageTitle: "Shop" };
const ctx = { requestId: "r", signal: new AbortController().signal, attempt: 1 as const, feedback: null };

test("[LLM-10] the none provider yields no-proposal: llm-disabled for both tasks and never calls fetch", async (t) => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.equal(noneProvider.name, "none");
  assert.deepEqual(await noneProvider.complete("alt-text", altInput, ctx), { kind: "no-proposal", reason: "llm-disabled" });
  assert.deepEqual(await noneProvider.complete("control-name", nameInput, ctx), { kind: "no-proposal", reason: "llm-disabled" });
  const fromFactory = createLlmProvider({ provider: "none" }, { readFixture: () => assert.fail("none reads no fixture") });
  assert.equal(fromFactory, noneProvider);
  assert.equal(called, 0);
});

test("[CS-10] the factory builds the fake from the named fixture, or from the bundled storefront fixture when none is named", async () => {
  const missing = join(import.meta.dirname, "..", "fixtures", "llm", "missing-key.json");
  const read: string[] = [];
  const readFixture = (path: string): unknown => {
    read.push(path);
    return JSON.parse(readFileSync(missing, "utf8"));
  };
  const lenient = createLlmProvider({ provider: "fake", fixture: missing, strict: false }, { readFixture });
  assert.equal(lenient.name, "fake");
  assert.deepEqual(await lenient.complete("alt-text", altInput, ctx), { kind: "no-proposal", reason: "no-scripted-answer" });
  const strict = createLlmProvider({ provider: "fake", fixture: null, strict: true }, { readFixture });
  await assert.rejects(strict.complete("alt-text", altInput, ctx), /UNSCRIPTED|no response/);
  assert.deepEqual(read, [missing, bundledFixturePath()]);
  assert.match(bundledFixturePath(), /fixtures[\\/]llm[\\/]storefront\.json$/);
});
