// Static server for the audited site (spec 5.3). Binds 127.0.0.1 only and never leaves the root.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { StaticServerFactory } from "../domain/ports.ts";
import { isInsideRoot } from "./paths.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export type StaticServer = { url: string; close(): Promise<void> };

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string, head: boolean): void {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(head ? undefined : body);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Maps a request path to a real file inside rootReal, or null (which becomes 404). */
async function resolveRequest(rootReal: string, rawUrl: string): Promise<string | null> {
  const rawPath = rawUrl.split("?")[0]!.split("#")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || !decoded.startsWith("/")) return null;
  const segments = decoded.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  const wantsIndex = decoded.endsWith("/");
  const base = join(rootReal, ...segments);

  const candidates: string[] = [];
  if (wantsIndex || segments.length === 0) candidates.push(join(base, "index.html"));
  else candidates.push(base, join(base, "index.html"), base + ".html");

  for (const candidate of candidates) {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isInsideRoot(rootReal, real)) continue;
    if (await isFile(real)) return real;
  }
  return null;
}

export async function startStaticServer({ root, port = 0 }: { root: string; port?: number }): Promise<StaticServer> {
  const rootReal = await realpath(root);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed", false);
    const file = await resolveRequest(rootReal, req.url ?? "/");
    if (file === null) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found", head);
    try {
      const body = await readFile(file);
      send(res, 200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Length": String(body.length) }, body, head);
    } catch {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found", head);
    }
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Server error", false);
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export const staticServerFactory: StaticServerFactory = { start: (root) => startStaticServer({ root }) };
