import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GUARD_ABS = resolve(import.meta.dirname, "no-network.ts");

/**
 * NODE_OPTIONS value that loads the no-network guard in a child process.
 * The project path contains a space, so the file URL (percent-encoded) is used, never the raw path.
 */
export function guardNodeOptions(): string {
  return `--import ${pathToFileURL(GUARD_ABS).href}`;
}
