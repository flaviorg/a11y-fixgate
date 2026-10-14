// Serves a scratch copy of a directory on loopback for e2e tests.
import { startStaticServer } from "../../src/infra/static-server.ts";
import { scratchFactory } from "../../src/infra/scratch.ts";
import type { AuditTarget } from "../../src/domain/ports.ts";

export type Served = { url: string; root: string; target(pagePath?: string, watch?: string[]): AuditTarget; close(): Promise<void> };

/** Copies root to a scratch directory, lets `edit` change the copy, and serves it. close() stops the server and removes the copy. */
export async function serveCopy(root: string, edit?: (dir: string) => void): Promise<Served> {
  const scratch = await scratchFactory.create(root);
  try {
    edit?.(scratch.root);
    const server = await startStaticServer({ root: scratch.root });
    return {
      url: server.url,
      root: scratch.root,
      target: (pagePath = "/", watch = []) => ({ url: server.url + pagePath, servedRoot: scratch.root, pagePath, watch: [...watch].sort() }),
      close: async () => {
        await server.close();
        scratch.dispose();
      },
    };
  } catch (error) {
    scratch.dispose();
    throw error;
  }
}
