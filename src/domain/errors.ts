// Error contract of spec 5.10. Pure: no node:* imports.

export type ErrorCode =
  | "USAGE"
  | "CONFIG_INVALID"
  | "NO_BROWSER"
  | "PAGE_LOAD_FAILED"
  | "AXE_VERSION_MISMATCH"
  | "SRC_TOO_LARGE"
  | "NO_RECORDING"
  | "COMBINED_MISMATCH"
  | "LLM_UNAVAILABLE"
  | "UNSCRIPTED_LLM_CALL"
  | "UNSAFE_PATH"
  | "FIXTURE_PROMPT_DRIFT"
  | "BOUNDED_PATCH";

/** Process exit code of each error code. BOUNDED_PATCH is a programming error and maps to 4. */
export const EXIT_CODE_OF: Record<ErrorCode, 1 | 2 | 3 | 4 | 5> = {
  USAGE: 2,
  CONFIG_INVALID: 2,
  NO_BROWSER: 3,
  PAGE_LOAD_FAILED: 4,
  AXE_VERSION_MISMATCH: 4,
  SRC_TOO_LARGE: 4,
  NO_RECORDING: 4,
  COMBINED_MISMATCH: 1,
  LLM_UNAVAILABLE: 5,
  UNSCRIPTED_LLM_CALL: 4,
  UNSAFE_PATH: 4,
  FIXTURE_PROMPT_DRIFT: 4,
  BOUNDED_PATCH: 4,
};

/** Internal error with a stable code. Messages never contain a key or a stack; details go to the log only. */
export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Why a provider gave up: a scripted error, or a network, HTTP or content failure of the real client. */
export type LlmUnavailableKind = "timeout" | "server_error" | "network" | "rate_limited" | "invalid_json" | "bad_request" | "http_error";

/** The LLM provider failed after its attempts (spec 5.10 LLM_UNAVAILABLE). The message never carries a key. */
export class LlmUnavailableError extends AppError {
  kind: LlmUnavailableKind;
  constructor(kind: LlmUnavailableKind, details?: unknown) {
    super("LLM_UNAVAILABLE", `LLM provider unavailable after 2 attempts (${kind}); LLM strategies skipped`, details);
    this.name = "LlmUnavailableError";
    this.kind = kind;
  }
}
