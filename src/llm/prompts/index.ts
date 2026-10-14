// The prompts in use, one per LLM task (spec 7.1). promptVersion of the run result is "v1".
import * as z from "zod";
import type { LlmInput, LlmTaskName } from "../../contracts/llm.ts";
import { altTextPrompt } from "./v1/alt-text.ts";
import { controlNamePrompt } from "./v1/control-name.ts";

/** A versioned prompt: name and system are hashed (promptHash); buildUser wraps page content in <untrusted-content>. */
export type Prompt<I> = {
  name: string;
  system: string;
  buildUser(input: I, feedback: string | null): string;
  outputSchema: z.ZodType;
};

export const PROMPTS: { [T in LlmTaskName]: Prompt<LlmInput<T>> } = {
  "alt-text": altTextPrompt,
  "control-name": controlNamePrompt,
};
