// LLM task contracts (spec 5.2, verbatim). Pure: zod only.
import * as z from "zod";

export type LlmTaskName = "alt-text" | "control-name";

export const altTextInput = z
  .object({
    pageTitle: z.string().max(200),
    src: z.string().max(500),
    surroundingText: z.string().max(600),
    insideControl: z.boolean(),
    image: z
      .object({
        mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        bytesBase64: z.string(),
        sha256: z.string().length(64),
        bytes: z.number().int().max(2_097_152),
      })
      .nullable(),
  })
  .strict(); // SVG images are sent without bytes (image: null); the model sees src and context only
export const altTextOutput = z
  .object({ kind: z.enum(["informative", "decorative"]), alt: z.string().max(400), reason: z.string().max(300) })
  .strict();

export const controlNameInput = z
  .object({
    role: z.enum(["button", "link", "textbox"]),
    html: z.string().max(400),
    surroundingText: z.string().max(600),
    href: z.string().max(500).nullable(),
    placeholder: z.string().max(200).nullable(),
    iconHints: z.array(z.string().max(60)).max(10),
    pageTitle: z.string().max(200),
  })
  .strict();
export const controlNameOutput = z.object({ name: z.string().max(200), reason: z.string().max(300) }).strict();

export type AltTextInput = z.infer<typeof altTextInput>;
export type AltTextOutput = z.infer<typeof altTextOutput>;
export type ControlNameInput = z.infer<typeof controlNameInput>;
export type ControlNameOutput = z.infer<typeof controlNameOutput>;

type InputOf = { "alt-text": AltTextInput; "control-name": ControlNameInput };
type OutputOf = { "alt-text": AltTextOutput; "control-name": ControlNameOutput };
export type LlmInput<T extends LlmTaskName> = InputOf[T];
export type LlmOutput<T extends LlmTaskName> = OutputOf[T];

export const LLM_INPUT_SCHEMA = { "alt-text": altTextInput, "control-name": controlNameInput } as const;
export const LLM_OUTPUT_SCHEMA = { "alt-text": altTextOutput, "control-name": controlNameOutput } as const;

/**
 * A provider resolves to a proposal or to "no proposal"; it throws only for infrastructure errors.
 * output is untrusted until the value gates (src/domain/fix/gates.ts) parse it: a scripted invalid_json
 * answer, for example, resolves as a raw string that the schema check refuses.
 */
export type LlmResult = { kind: "proposal"; output: unknown } | { kind: "no-proposal"; reason: "llm-disabled" | "no-scripted-answer" };
