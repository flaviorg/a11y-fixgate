// Configuration contracts (spec 5.2, 5.11). Pure: zod only.
import * as z from "zod";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** z.url() accepts javascript: and file:, so the protocol check is required. */
export const httpsOrLoopback = z.url().refine((u) => {
  const p = new URL(u);
  return p.protocol === "https:" || (p.protocol === "http:" && LOOPBACK_HOSTS.includes(p.hostname));
}, "must be https, or http on loopback");

export const auditConfigSchema = z
  .object({
    sourceRoot: z.string().min(1),
    pagePath: z.string().regex(/^\/[A-Za-z0-9._~\/-]*$/).default("/"),
    out: z.string().min(1).default("reports/latest"),
    write: z.boolean().default(false),
    fix: z.boolean().default(true),
    maxFixes: z.number().int().min(0).max(100).default(25),
    maxCandidates: z.number().int().min(1).max(300).default(60), // verified candidates (browser re-audits) per run
    maxLlmCalls: z.number().int().min(0).max(200).default(40),
    deadlineMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
    lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).nullable().default(null), // null: html-lang is suggest-only unless the page carries a signal
    failOn: z.enum(["none", "minor", "moderate", "serious", "critical"]).default("none"),
    sarif: z.boolean().default(true),
    repoRoot: z.string().min(1).nullable().default(null), // null: GITHUB_WORKSPACE if set, else the current working directory
    allowNewIncomplete: z.boolean().default(false),
    browser: z.object({ executablePath: z.string().nullable(), source: z.enum(["env", "playwright", "recorded"]) }),
    llm: z.discriminatedUnion("provider", [
      z.object({ provider: z.literal("none") }),
      z.object({
        provider: z.literal("fake"),
        fixture: z.string().min(1).nullable().default(null), // null: the bundled storefront fixture, resolved by src/cli.ts from import.meta.dirname (never the cwd)
        strict: z.boolean().default(false),
      }),
      z.object({
        provider: z.literal("openai-compatible"),
        baseUrl: httpsOrLoopback,
        model: z.string().min(1),
        apiKey: z.string().min(8),
        timeoutMs: z.number().int().min(1000).max(120000),
        requestOverrides: z.record(z.string(), z.unknown()).default({}),
      }),
    ]),
  })
  .strict();
export type AuditConfig = z.infer<typeof auditConfigSchema>;

/** The 12 environment variables of spec 5.11, in the order of the table (REP-02 checks .env.example against it). */
export const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_TIMEOUT_MS",
  "LLM_REQUEST_OVERRIDES",
  "A11Y_REPO_ROOT",
  "A11Y_BROWSER_PATH",
  "REQUIRE_BROWSER",
  "CI",
  "LOG_LEVEL",
  "A11Y_OUT",
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];
