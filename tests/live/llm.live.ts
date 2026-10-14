// npm run test:live (spec 7.4, LLM-08). Outside npm test: no network guard is loaded and a real model is
// called. It sends the four alt-text inputs of fixtures/llm/storefront.json (with the image bytes read from
// fixtures/storefront) and asserts only that every proposal passes the value gates. Without LLM_API_KEY it skips.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { auditConfigSchema } from "../../src/contracts/config.ts";
import { altTextInput } from "../../src/contracts/llm.ts";
import type { AltTextInput } from "../../src/contracts/llm.ts";
import { altGate } from "../../src/domain/fix/gates.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { llmFixtureSchema } from "../../src/llm/fixture-format.ts";
import { createOpenAiCompatibleProvider } from "../../src/llm/openai-compatible.ts";

const PROJECT = join(import.meta.dirname, "..", "..");

/** The distinct attempt-1 alt-text inputs of the storefront fixture, with the image bytes read from disk. */
function storefrontAltInputs(): AltTextInput[] {
  const fixture = llmFixtureSchema.parse(JSON.parse(readFileSync(join(PROJECT, "fixtures", "llm", "storefront.json"), "utf8")));
  const seen = new Set<string>();
  const inputs: AltTextInput[] = [];
  for (const r of fixture.responses) {
    if (r.task !== "alt-text" || seen.has(r.key)) continue;
    seen.add(r.key);
    // The fixture stores the keyed input: image without bytesBase64 (spec 7.1).
    const stored = r.input as { src: string; image: { sha256: string } | null };
    let image: unknown = null;
    if (stored.image) {
      const bytes = readFileSync(join(PROJECT, "fixtures", "storefront", ...stored.src.split("/")));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), stored.image.sha256, `${stored.src} changed since the fixture was keyed`);
      image = { ...stored.image, bytesBase64: bytes.toString("base64") };
    }
    inputs.push(altTextInput.parse({ ...stored, image }));
  }
  return inputs;
}

test("[LLM-08] real alt-text proposals for the four storefront images pass the value gates", { timeout: 300_000 }, async (t) => {
  const apiKey = process.env.LLM_API_KEY ?? "";
  if (apiKey === "") {
    t.skip("LLM_API_KEY is not set");
    return;
  }
  const llm = auditConfigSchema.shape.llm.parse({
    provider: "openai-compatible",
    baseUrl: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    model: process.env.LLM_MODEL ?? "",
    apiKey,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 30000),
    requestOverrides: process.env.LLM_REQUEST_OVERRIDES ? JSON.parse(process.env.LLM_REQUEST_OVERRIDES) : {},
  });
  if (llm.provider !== "openai-compatible") throw new Error("unreachable");
  const provider = createOpenAiCompatibleProvider(llm, { fetch: globalThis.fetch, logger: createLogger({ component: "llm", level: "warn" }) });
  const inputs = storefrontAltInputs();
  assert.equal(inputs.length, 4);
  for (const [i, input] of inputs.entries()) {
    const res = await provider.complete("alt-text", input, { requestId: `live-${i + 1}`, signal: new AbortController().signal, attempt: 1, feedback: null });
    assert.equal(res.kind, "proposal");
    if (res.kind !== "proposal") continue;
    const gated = altGate(res.output, input, input.surroundingText);
    assert.ok(gated.ok, `${input.src}: ${gated.ok ? "" : gated.reason}`);
  }
});
