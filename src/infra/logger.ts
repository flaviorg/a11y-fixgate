// Structured logger (spec 5.12): one JSON line per event, redacted, detail strings cut to 500 chars.
import type { Clock, LogFields, Logger } from "../domain/ports.ts";
import { redactSecrets } from "./redact.ts";
import { systemClock } from "./clock.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(["ts", "level", "component", "event"]);
export const MAX_DETAIL_CHARS = 500;

export type LoggerOptions = {
  component: string;
  level: LogLevel;
  /** Receives one JSON line without a trailing newline. Defaults to stderr. */
  write?: (line: string) => void;
  clock?: Clock;
  fields?: LogFields;
};

function cut(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_DETAIL_CHARS ? value.slice(0, MAX_DETAIL_CHARS) : value;
  if (Array.isArray(value)) return value.map(cut);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]));
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const { component, level } = options;
  const clock = options.clock ?? systemClock;
  const write = options.write ?? ((line: string) => void process.stderr.write(line + "\n"));
  const base = options.fields ?? {};

  const emit = (at: LogLevel, event: string, fields?: LogFields): void => {
    if (ORDER[at] < ORDER[level]) return;
    // Redact first, then cut: a cut must never leave a partial key that no pattern recognizes.
    const safe = cut(redactSecrets({ ...base, ...fields })) as LogFields;
    const record: Record<string, unknown> = { ts: clock.now().toISOString(), level: at, component, event };
    for (const [key, value] of Object.entries(safe)) if (!RESERVED.has(key)) record[key] = value;
    write(JSON.stringify(record));
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    // A child may switch the component (spec 5.12: cli, runner, loop, llm, output); other fields are added to every line.
    child: ({ component: next, ...fields }) => createLogger({ ...options, component: typeof next === "string" ? next : component, fields: { ...base, ...fields } }),
  };
}
