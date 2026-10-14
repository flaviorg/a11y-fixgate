// Network guard for npm test (spec 6.2 item 9, plan P-9).
// Loaded with `--import` by the npm test scripts, and in child processes through
// NODE_OPTIONS built by guardNodeOptions().
//  - globalThis.fetch: loopback URLs go to the original, any other URL rejects with NO_NETWORK.
//  - net.Socket.prototype.connect: loopback hosts and Unix sockets connect, anything else is destroyed.
import net from "node:net";

const MARK = Symbol.for("a11y.noNetwork");
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

type ConnectOptions = { host?: unknown; hostname?: unknown; path?: unknown };
type Target = { kind: "file" } | { kind: "tcp"; host: string };

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const stripBrackets = (host: string): string => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

export class NetworkDisabledInTests extends Error {
  code: "NO_NETWORK";
  constructor(message: string) {
    super(message);
    this.name = "NetworkDisabledInTests";
    this.code = "NO_NETWORK";
  }
}

/** Normalizes connect(options), connect(port, host) and connect([options, cb]) to a target. */
export function targetOf(args: unknown[]): Target {
  // connect([options, cb]) is the internal normalized form used by net.createConnection, http and undici.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    const options = first as ConnectOptions;
    if (isNonEmptyString(options.path)) return { kind: "file" };
    const host = options.host ?? options.hostname ?? "localhost";
    return { kind: "tcp", host: stripBrackets(String(host)) };
  }
  // connect(path[, cb]): a non-numeric string is a Unix socket or pipe path.
  if (isNonEmptyString(first) && Number.isNaN(Number(first))) return { kind: "file" };
  // connect(port[, host][, cb])
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { kind: "tcp", host: stripBrackets(host) };
}

function urlOf(input: unknown): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    if (input !== null && typeof input === "object" && "url" in input) return new URL(String((input as { url: unknown }).url));
  } catch {
    return null;
  }
  return null;
}

const globals = globalThis as unknown as Record<symbol, unknown>;

if (!globals[MARK]) {
  globals[MARK] = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input);
    const host = url ? stripBrackets(url.hostname) : "";
    if (!url || !ALLOWED_HOSTS.has(host)) {
      throw new NetworkDisabledInTests(`network disabled in tests: fetch to ${url ? url.host : "an unparseable URL"}`);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const originalConnect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;
  const guardedConnect = function connect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = targetOf(args);
    if (target.kind === "file" || ALLOWED_HOSTS.has(target.host)) return originalConnect.apply(this, args);
    process.nextTick(() => this.destroy(Object.assign(new Error("network disabled in tests"), { code: "NO_NETWORK" })));
    return this;
  };
  net.Socket.prototype.connect = guardedConnect as typeof net.Socket.prototype.connect;
}
