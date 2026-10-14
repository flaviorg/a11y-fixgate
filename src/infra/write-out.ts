// The only place the process writes to its standard streams (spec 5.12, CLI-04): every string is redacted first.
import { redactText } from "./redact.ts";

/** Writes one line (or block) to stdout. */
export function writeOut(text: string): void {
  process.stdout.write(redactText(text) + "\n");
}

/** Writes one line (or block) to stderr. */
export function writeErr(text: string): void {
  process.stderr.write(redactText(text) + "\n");
}
