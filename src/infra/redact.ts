// Secret redaction (spec 5.12). Every string that leaves the process goes through here.

const REDACTED = "[REDACTED]";
const SECRET_FIELDS = new Set(["apikey", "authorization", "llm_api_key"]);

// Specific prefixes first: sk-or-v1- and sk-ant- are also matched by the generic sk- pattern.
// The lookbehind keeps ordinary words that end in "sk-" (for example "risk-assessment-...") untouched.
const PATTERNS: Array<[RegExp, string]> = [
  [/(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{16,}/g, "<redacted:sk-or-v1->"],
  [/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g, "<redacted:sk-ant->"],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, "<redacted:sk->"],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g, "<redacted:AIza>"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, seen));
    if (value instanceof Error) {
      const out: Record<string, unknown> = { name: value.name, message: redactText(value.message) };
      const code = (value as { code?: unknown }).code;
      if (typeof code === "string") out["code"] = code;
      return out;
    }
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_FIELDS.has(key.toLowerCase()) ? REDACTED : walk(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Returns a redacted deep copy: secret field names become "[REDACTED]" and key-shaped strings are masked. */
export function redactSecrets(value: unknown): unknown {
  return walk(value, new WeakSet());
}
