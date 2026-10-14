// HTML escaping for the report (spec 5.8, OUT-07). Every string enters the template through html`...`,
// which escapes each interpolation with escapeHtml unless it is already a Raw fragment built by html`...`.
// Values are redacted before they are escaped, because the redaction marker contains "<" and ">".
import { redactText } from "../infra/redact.ts";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Redacts key-shaped strings, then escapes &, <, >, " and '. Anything that is not a string is converted with String(). */
export function escapeHtml(v: unknown): string {
  return redactText(String(v)).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** A fragment that is already safe HTML (built by html`...`, or the trusted template text itself). */
export class Raw {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
  toString(): string {
    return this.html;
  }
}

/** Marks template text the author wrote (never page content or model output) as safe. */
export const raw = (trusted: string): Raw => new Raw(trusted);

function part(v: unknown): string {
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(v);
}

/** Tagged template: literal parts are trusted, interpolations are escaped (arrays are joined, Raw passes through). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? "");
  });
  return new Raw(out);
}
