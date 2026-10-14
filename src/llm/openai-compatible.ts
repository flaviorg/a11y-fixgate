// The OpenAI-compatible client over raw fetch (spec 7.4; LLM-06). The only fetch caller in src/.
// POST <baseUrl>/chat/completions in JSON mode; two attempts on a network error, 429, 5xx or invalid JSON;
// a 400 (or another 4xx) is not retried. The key goes into the Authorization header only and is masked in
// every error and log line.
import type { AuditConfig } from "../contracts/config.ts";
import type { LlmInput, LlmResult, LlmTaskName } from "../contracts/llm.ts";
import { TOOL } from "../contracts/tool.ts";
import { LlmUnavailableError } from "../domain/errors.ts";
import type { LlmUnavailableKind } from "../domain/errors.ts";
import type { LlmCallContext, LlmProvider, Logger } from "../domain/ports.ts";
import { redactText } from "../infra/redact.ts";
import { PROMPTS } from "./prompts/index.ts";

export type OpenAiCompatibleConfig = Extract<AuditConfig["llm"], { provider: "openai-compatible" }>;

const ATTEMPTS = 2;
const DETAIL_MAX = 500;

type Failure = { kind: LlmUnavailableKind; retry: boolean; status: number | null; detail: string };

/** Merges the overrides over the body; a null value deletes the field (spec 5.11 LLM_REQUEST_OVERRIDES). */
export function mergeOverrides(body: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

function imagePartOf(input: unknown): { type: "image_url"; image_url: { url: string } } | null {
  if (input === null || typeof input !== "object") return null;
  const image = (input as { image?: unknown }).image;
  if (image === null || typeof image !== "object") return null;
  const { mime, bytesBase64 } = image as { mime?: unknown; bytesBase64?: unknown };
  if (typeof mime !== "string" || typeof bytesBase64 !== "string") return null;
  return { type: "image_url", image_url: { url: `data:${mime};base64,${bytesBase64}` } };
}

/** The content of the first choice, parsed as JSON; undefined when the response is not the expected shape or not JSON. */
function contentOf(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false };
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false };
  }
}

export function createOpenAiCompatibleProvider(cfg: OpenAiCompatibleConfig, deps: { fetch: typeof fetch; logger: Logger }): LlmProvider {
  const log = deps.logger.child({ component: "llm" });
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const isOpenRouter = new URL(cfg.baseUrl).hostname === "openrouter.ai";
  /** Masks the key itself (whatever its shape) and every key-shaped string, then cuts. */
  const clean = (text: string): string => redactText(text.split(cfg.apiKey).join("[REDACTED]")).slice(0, DETAIL_MAX);

  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
  if (isOpenRouter) {
    headers["HTTP-Referer"] = TOOL.informationUri;
    headers["X-Title"] = TOOL.name;
  }

  async function once(body: string, ctx: LlmCallContext): Promise<{ ok: true; value: unknown } | { ok: false; failure: Failure }> {
    let response: Response;
    try {
      response = await deps.fetch(url, { method: "POST", headers, body, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(cfg.timeoutMs)]) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const kind: LlmUnavailableKind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      return { ok: false, failure: { kind, retry: !ctx.signal.aborted, status: null, detail: clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error)) } };
    }
    const text = await response.text().catch(() => "");
    if (response.status === 429) return { ok: false, failure: { kind: "rate_limited", retry: true, status: 429, detail: clean(text) } };
    if (response.status >= 500) return { ok: false, failure: { kind: "server_error", retry: true, status: response.status, detail: clean(text) } };
    if (response.status === 400) return { ok: false, failure: { kind: "bad_request", retry: false, status: 400, detail: clean(text) } };
    if (!response.ok) return { ok: false, failure: { kind: "http_error", retry: false, status: response.status, detail: clean(text) } };
    const parsed = contentOf(text);
    if (!parsed.ok) return { ok: false, failure: { kind: "invalid_json", retry: true, status: response.status, detail: clean(text) } };
    return parsed;
  }

  return {
    name: "openai-compatible",
    async complete<T extends LlmTaskName>(task: T, input: LlmInput<T>, ctx: LlmCallContext): Promise<LlmResult> {
      const prompt = PROMPTS[task] as { system: string; buildUser(i: LlmInput<T>, f: string | null): string };
      const image = imagePartOf(input);
      const userContent: Array<Record<string, unknown>> = [{ type: "text", text: prompt.buildUser(input, ctx.feedback) }];
      if (image) userContent.push(image);
      const body = mergeOverrides(
        {
          model: cfg.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: userContent },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
          max_tokens: 300,
        },
        cfg.requestOverrides,
      );
      const payload = JSON.stringify(body);

      let last: Failure | null = null;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const result = await once(payload, ctx);
        if (result.ok) return { kind: "proposal", output: result.value };
        last = result.failure;
        log.warn("provider_failure", { requestId: ctx.requestId, task, attempt, kind: last.kind, status: last.status, retry: last.retry && attempt < ATTEMPTS, detail: last.detail });
        if (!last.retry) break;
      }
      throw new LlmUnavailableError(last!.kind, { status: last!.status, detail: last!.detail });
    },
  };
}
