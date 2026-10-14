// The provider factory (spec 7.1): none, the scripted fake, or the OpenAI-compatible client.
import { join } from "node:path";
import type { AuditConfig } from "../contracts/config.ts";
import type { Logger, LlmProvider } from "../domain/ports.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { noneProvider } from "./none-provider.ts";
import { createOpenAiCompatibleProvider } from "./openai-compatible.ts";

/** fixtures/llm/storefront.json of this tool, resolved from this file's directory (never from the cwd). */
export function bundledFixturePath(): string {
  return join(import.meta.dirname, "..", "..", "fixtures", "llm", "storefront.json");
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

export type ProviderDeps = {
  /** Reads and JSON-parses a fixture file (the fake validates it). */
  readFixture: (path: string) => unknown;
  /** Required for openai-compatible; the CLI passes globalThis.fetch. */
  fetch?: typeof fetch;
  logger?: Logger;
};

export function createLlmProvider(config: AuditConfig["llm"], deps: ProviderDeps): LlmProvider {
  switch (config.provider) {
    case "none":
      return noneProvider;
    case "fake":
      return createFakeProvider({ fixture: deps.readFixture(config.fixture ?? bundledFixturePath()), strict: config.strict });
    case "openai-compatible": {
      if (!deps.fetch) throw new Error("createLlmProvider: openai-compatible needs a fetch implementation");
      return createOpenAiCompatibleProvider(config, { fetch: deps.fetch, logger: deps.logger ?? silent });
    }
  }
}
