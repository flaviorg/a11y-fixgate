// The none provider (spec 7.1, LLM-10): every call resolves to "no proposal" without touching the network.
import type { LlmProvider } from "../domain/ports.ts";

export const noneProvider: LlmProvider = {
  name: "none",
  async complete() {
    return { kind: "no-proposal", reason: "llm-disabled" };
  },
};
