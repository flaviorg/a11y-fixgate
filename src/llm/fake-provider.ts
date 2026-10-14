// The scripted LLM provider (spec 7.1 to 7.3; LLM-01, LLM-05, LLM-07). Answers from one fixture by
// (key, attempt); never touches the network; usage is zero.
import type { LlmInput, LlmResult, LlmTaskName } from "../contracts/llm.ts";
import { AppError, LlmUnavailableError } from "../domain/errors.ts";
import type { LlmCallContext, LlmProvider } from "../domain/ports.ts";
import { llmFixtureSchema, llmKey, promptHash } from "./fixture-format.ts";
import type { LlmFixture } from "./fixture-format.ts";
import { PROMPTS } from "./prompts/index.ts";

export type FakeCall = { task: LlmTaskName; key: string; attempt: 1 | 2; hadImage: boolean; imageSha256: string | null; mime: string | null };

export type FakeProvider = LlmProvider & { calls(): FakeCall[] };

/** The image part of an alt-text input, when there is one. */
function imageOf(input: unknown): { sha256: string; mime: string } | null {
  if (input === null || typeof input !== "object") return null;
  const image = (input as { image?: unknown }).image;
  if (image === null || typeof image !== "object") return null;
  const { sha256, mime } = image as { sha256?: unknown; mime?: unknown };
  return typeof sha256 === "string" && typeof mime === "string" ? { sha256, mime } : null;
}

/** Throws FIXTURE_PROMPT_DRIFT when the fixture's hash of a current prompt is absent or different. */
export function assertPromptHashes(fixture: LlmFixture): void {
  for (const prompt of Object.values(PROMPTS)) {
    if (fixture.promptHashes[prompt.name] !== promptHash(prompt)) {
      throw new AppError("FIXTURE_PROMPT_DRIFT", `Prompt ${prompt.name} changed; run npm run fixtures:rekey`, { prompt: prompt.name });
    }
  }
}

/**
 * Validates the fixture and its prompt hashes at creation. Unknown (key, attempt): strict mode throws
 * UNSCRIPTED_LLM_CALL, lenient mode resolves no-proposal: no-scripted-answer. timeout and server_error
 * throw LlmUnavailableError; invalid_json resolves as a raw string, which the schema gate refuses.
 */
export function createFakeProvider({ fixture, strict }: { fixture: unknown; strict: boolean }): FakeProvider {
  const parsed = llmFixtureSchema.parse(fixture);
  assertPromptHashes(parsed);
  const calls: FakeCall[] = [];
  return {
    name: "fake",
    async complete<T extends LlmTaskName>(task: T, input: LlmInput<T>, ctx: LlmCallContext): Promise<LlmResult> {
      const key = llmKey(task, input);
      const image = imageOf(input);
      calls.push({ task, key, attempt: ctx.attempt, hadImage: image !== null, imageSha256: image?.sha256 ?? null, mime: image?.mime ?? null });
      const hit = parsed.responses.find((r) => r.task === task && r.key === key && r.attempt === ctx.attempt);
      if (!hit) {
        if (!strict) return { kind: "no-proposal", reason: "no-scripted-answer" };
        const known = [...new Set(parsed.responses.filter((r) => r.task === task).map((r) => r.key))];
        throw new AppError(
          "UNSCRIPTED_LLM_CALL",
          `Fake LLM has no response for task ${task} key ${key}; known keys for this task: [${known.join(", ")}]. Without --strict-fake this becomes a suggestion`,
          { task, key, attempt: ctx.attempt },
        );
      }
      if (hit.error === "timeout" || hit.error === "server_error") throw new LlmUnavailableError(hit.error, { task, key, attempt: ctx.attempt });
      if (hit.error === "invalid_json") return { kind: "proposal", output: "{ this is not JSON (scripted invalid_json)" };
      return { kind: "proposal", output: structuredClone(hit.output) };
    },
    calls: () => calls.map((c) => ({ ...c })),
  };
}
