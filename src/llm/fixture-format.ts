// Format of the scripted LLM answers (spec 7.2) and the hashes that key them (spec 7.1).
import { createHash } from "node:crypto";
import * as z from "zod";
import type { LlmInput, LlmTaskName } from "../contracts/llm.ts";

export const llmFixtureResponseSchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    task: z.enum(["alt-text", "control-name"]),
    label: z.string(),
    input: z.unknown(),
    attempt: z.number().int().min(1).max(2).default(1),
    output: z.unknown().optional(),
    error: z.enum(["timeout", "server_error", "invalid_json"]).optional(),
  })
  .refine((r) => (r.output === undefined) !== (r.error === undefined), { message: "exactly one of output or error" });

export const llmFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenario: z.string(),
    promptHashes: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/)),
    responses: z.array(llmFixtureResponseSchema),
  })
  .strict();
export type LlmFixture = z.infer<typeof llmFixtureSchema>;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** JSON with object keys sorted recursively (arrays keep their order; undefined members are dropped, as in JSON.stringify). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** The input as it is keyed: image.bytesBase64 removed (sha256, mime and bytes stay), so keys are stable and fixtures small. */
export function keyInputOf(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const image = record["image"];
  if (image === null || typeof image !== "object" || Array.isArray(image)) return input;
  const { bytesBase64: _bytes, ...rest } = image as Record<string, unknown>;
  return { ...record, image: rest };
}

/** sha256(task + "\n" + canonicalJson(input without image.bytesBase64)), 64 hex chars (spec 7.1). */
export function llmKey<T extends LlmTaskName>(task: T, input: LlmInput<T> | unknown): string {
  return sha256(task + "\n" + canonicalJson(keyInputOf(input)));
}

/** "sha256:" + sha256(name + "\n" + system): a fixture records it per prompt and the fake refuses a mismatch. */
export function promptHash(prompt: { name: string; system: string }): string {
  return "sha256:" + sha256(prompt.name + "\n" + prompt.system);
}
