// The OpenAI-compatible client over an injected fetch (spec 7.4; LLM-06). No request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import type { AuditConfig } from "../../src/contracts/config.ts";
import type { AltTextInput, ControlNameInput } from "../../src/contracts/llm.ts";
import { LlmUnavailableError } from "../../src/domain/errors.ts";
import type { LlmCallContext } from "../../src/domain/ports.ts";
import { createLogger } from "../../src/infra/logger.ts";
import { createOpenAiCompatibleProvider } from "../../src/llm/openai-compatible.ts";
import { PROMPTS } from "../../src/llm/prompts/index.ts";

type OpenAiConfig = Extract<AuditConfig["llm"], { provider: "openai-compatible" }>;
const KEY = "sk-or-v1-" + "a".repeat(40);
const cfg = (over: Partial<OpenAiConfig> = {}): OpenAiConfig => ({ provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "vendor/model-1", apiKey: KEY, timeoutMs: 30000, requestOverrides: {}, ...over });
const altInput: AltTextInput = { pageTitle: "Orbit Outfitters", src: "images/hero.png", surroundingText: "Orbit Outfitters", insideControl: false, image: { mime: "image/png", bytesBase64: "iVBORw0KGgo=", sha256: "b".repeat(64), bytes: 8 } };
const nameInput: ControlNameInput = { role: "button", html: '<button class="cart">', surroundingText: "", href: null, placeholder: null, iconHints: ["cart"], pageTitle: "Orbit Outfitters" };
const ctx = (over: Partial<LlmCallContext> = {}): LlmCallContext => ({ requestId: "req-1", signal: new AbortController().signal, attempt: 1, feedback: null, ...over });

type Recorded = { url: string; init: RequestInit; body: Record<string, unknown>; headers: Record<string, string> };
type Reply = Response | Error;

/** A fetch that records each request and answers from a queue (an Error is thrown, as fetch does on a network failure). */
function fakeFetch(replies: Reply[]) {
  const requests: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")), headers });
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fn, requests };
}
const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, body = `{"error":{"message":"status ${code}"}}`) => new Response(body, { status: code });

function logCollector() {
  const lines: string[] = [];
  return { lines, logger: createLogger({ component: "llm", level: "debug", write: (l) => lines.push(l) }) };
}

test("[LLM-06] the request goes to <baseUrl>/chat/completions with model, temperature 0, json_object, max_tokens 300 and the image as an image_url data URL", async () => {
  const { fetch, requests } = fakeFetch([ok({ kind: "informative", alt: "Autumn collection banner", reason: "hero" })]);
  const provider = createOpenAiCompatibleProvider(cfg({ baseUrl: "https://llm.example/v1/" }), { fetch, logger: logCollector().logger });
  assert.equal(provider.name, "openai-compatible");
  const res = await provider.complete("alt-text", altInput, ctx({ feedback: "alt-is-filename" }));
  assert.deepEqual(res, { kind: "proposal", output: { kind: "informative", alt: "Autumn collection banner", reason: "hero" } });
  assert.equal(requests.length, 1);
  const [r] = requests;
  assert.equal(r!.url, "https://llm.example/v1/chat/completions");
  assert.equal(r!.init.method, "POST");
  assert.equal(r!.headers["authorization"], `Bearer ${KEY}`);
  assert.equal(r!.headers["content-type"], "application/json");
  assert.ok(r!.init.signal instanceof AbortSignal);
  const body = r!.body as { model: string; temperature: number; response_format: unknown; max_tokens: number; messages: Array<{ role: string; content: unknown }> };
  assert.deepEqual([body.model, body.temperature, body.response_format, body.max_tokens], ["vendor/model-1", 0, { type: "json_object" }, 300]);
  assert.deepEqual(body.messages[0], { role: "system", content: PROMPTS["alt-text"].system });
  const user = body.messages[1] as { role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> };
  assert.equal(user.role, "user");
  assert.equal(user.content[0]!.type, "text");
  assert.equal(user.content[0]!.text, PROMPTS["alt-text"].buildUser(altInput, "alt-is-filename"));
  assert.deepEqual(user.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });

  const plain = fakeFetch([ok({ name: "Open cart", reason: "cart icon" })]);
  const p2 = createOpenAiCompatibleProvider(cfg(), { fetch: plain.fetch, logger: logCollector().logger });
  assert.deepEqual(await p2.complete("control-name", nameInput, ctx()), { kind: "proposal", output: { name: "Open cart", reason: "cart icon" } });
  const content = (plain.requests[0]!.body as { messages: Array<{ content: unknown }> }).messages[1]!.content as Array<{ type: string }>;
  assert.deepEqual(content.map((c) => c.type), ["text"], "no image part without an image");
});

test("[LLM-06] OpenRouter headers are sent only for openrouter.ai", async () => {
  const router = fakeFetch([ok({ name: "Open cart", reason: "r" })]);
  await createOpenAiCompatibleProvider(cfg(), { fetch: router.fetch, logger: logCollector().logger }).complete("control-name", nameInput, ctx());
  assert.equal(router.requests[0]!.headers["http-referer"], "https://github.com/flaviorg/a11y-fixgate");
  assert.equal(router.requests[0]!.headers["x-title"], "a11y-fixgate");
  for (const baseUrl of ["https://api.openai.com/v1", "http://127.0.0.1:11434/v1", "https://openrouter.ai.evil.example/v1"]) {
    const other = fakeFetch([ok({ name: "Open cart", reason: "r" })]);
    await createOpenAiCompatibleProvider(cfg({ baseUrl }), { fetch: other.fetch, logger: logCollector().logger }).complete("control-name", nameInput, ctx());
    assert.equal(other.requests[0]!.headers["http-referer"], undefined, baseUrl);
    assert.equal(other.requests[0]!.headers["x-title"], undefined, baseUrl);
  }
});

test("[LLM-06] requestOverrides are merged and a null deletes a field ({\"max_tokens\":null,\"max_completion_tokens\":300,\"temperature\":null})", async () => {
  const { fetch, requests } = fakeFetch([ok({ name: "Open cart", reason: "r" })]);
  const provider = createOpenAiCompatibleProvider(cfg({ requestOverrides: { max_tokens: null, max_completion_tokens: 300, temperature: null, top_p: 0.5 } }), { fetch, logger: logCollector().logger });
  await provider.complete("control-name", nameInput, ctx());
  const body = requests[0]!.body;
  assert.equal("max_tokens" in body, false);
  assert.equal("temperature" in body, false);
  assert.deepEqual([body["max_completion_tokens"], body["top_p"], body["model"]], [300, 0.5, "vendor/model-1"]);
  assert.deepEqual(body["response_format"], { type: "json_object" });
});

test("[LLM-06] a network error, 429, 5xx or invalid JSON is retried once; a 400 is not; after two failures it throws LlmUnavailableError", async () => {
  const good = () => ok({ name: "Open cart", reason: "r" });
  const retried: Array<[string, Reply]> = [
    ["network", new TypeError("fetch failed")],
    ["rate_limited", status(429)],
    ["server_error", status(503)],
    ["invalid_json", ok("this is { not json")],
    ["invalid_json", new Response("<html>gateway</html>", { status: 200 })],
  ];
  for (const [kind, first] of retried) {
    const { fetch, requests } = fakeFetch([first, good()]);
    const res = await createOpenAiCompatibleProvider(cfg(), { fetch, logger: logCollector().logger }).complete("control-name", nameInput, ctx());
    assert.equal(res.kind, "proposal", kind);
    assert.equal(requests.length, 2, `${kind} is retried once`);
  }
  for (const [kind, first] of [["server_error", status(500)], ["rate_limited", status(429)], ["network", new TypeError("fetch failed")]] as Array<[string, Reply]>) {
    const second = first instanceof Error ? new TypeError("fetch failed") : status(first.status);
    const { fetch, requests } = fakeFetch([first, second]);
    await assert.rejects(createOpenAiCompatibleProvider(cfg(), { fetch, logger: logCollector().logger }).complete("control-name", nameInput, ctx()), (e: unknown) => {
      assert.ok(e instanceof LlmUnavailableError);
      assert.equal(e.kind, kind);
      assert.equal(e.code, "LLM_UNAVAILABLE");
      assert.equal(e.message, `LLM provider unavailable after 2 attempts (${kind}); LLM strategies skipped`);
      return true;
    });
    assert.equal(requests.length, 2);
  }
  const bad = fakeFetch([status(400), good()]);
  await assert.rejects(createOpenAiCompatibleProvider(cfg(), { fetch: bad.fetch, logger: logCollector().logger }).complete("control-name", nameInput, ctx()), (e: unknown) => e instanceof LlmUnavailableError && e.kind === "bad_request");
  assert.equal(bad.requests.length, 1, "a 400 is not retried");

  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const slow = fakeFetch([timeout, timeout]);
  await assert.rejects(createOpenAiCompatibleProvider(cfg({ timeoutMs: 1000 }), { fetch: slow.fetch, logger: logCollector().logger }).complete("control-name", nameInput, ctx()), (e: unknown) => e instanceof LlmUnavailableError && e.kind === "timeout");
});

test("[LLM-06] the key never appears in an error message or a log line", async () => {
  for (const key of [KEY, "local-key-" + "z".repeat(12)]) {
    const leaky = new TypeError(`connect failed while sending Authorization: Bearer ${key}`);
    const { fetch } = fakeFetch([leaky, status(500, `{"error":"bad key ${key}"}`)]);
    const { lines, logger } = logCollector();
    let caught: unknown;
    try {
      await createOpenAiCompatibleProvider(cfg({ apiKey: key }), { fetch, logger }).complete("control-name", nameInput, ctx());
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof LlmUnavailableError);
    const everything = [caught.message, String(caught.stack ?? ""), JSON.stringify(caught.details ?? null), ...lines].join("\n");
    assert.ok(lines.length >= 1, "the retry is logged");
    assert.equal(everything.includes(key), false, `key leaked: ${everything}`);
    assert.equal(everything.includes(key.slice(0, 20)), false);
  }
});
