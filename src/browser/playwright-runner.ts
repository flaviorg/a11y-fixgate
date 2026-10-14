// The browser audit runner (spec 5.3). The only module that drives Playwright.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import type { NodeDescriptor } from "../contracts/finding.ts";
import { auditSnapshotSchema, axeRawResultSchema } from "../contracts/snapshot.ts";
import type { AuditProfile, AuditSnapshot, AxeRawResult, TraversalStep, TraversalTrace } from "../contracts/snapshot.ts";
import { AppError } from "../domain/errors.ts";
import type { AuditOptions, AuditRunner, AuditTarget, Logger } from "../domain/ports.ts";
import { treeSha256 } from "../infra/tree-hash.ts";
import { axeRunOptions, installedAxe } from "./axe-config.ts";
import { noBrowserMessage } from "./browser-resolve.ts";
import { collectIds, describeNode, interactiveCandidates, traversalStep } from "./page-scripts.ts";
import { analyzeKeyboard } from "../domain/keyboard/analyze.ts";
import { domKey } from "../domain/verify/fingerprint.ts";

export const LIMITS = {
  loadMs: 15_000,
  axeMs: 30_000,
  nodes: 1_000,
  ariaNodes: 1_000,
  ariaBodyChars: 200 * 1024,
  ariaNodeChars: 4 * 1024,
  ariaNodeTimeoutMs: 2_000,
  keyboardMs: 20_000,
} as const;

export type PlaywrightRunnerOptions = {
  executablePath: string;
  /** Directory that receives screenshots/<name>; null means no screenshot is ever written. */
  outDir: string | null;
  logger: Logger;
  /** The axe build to inject and the version it must report; defaults to the installed package. */
  axe?: { version: string; source: string };
};

type AxeRunResults = {
  testEngine: { version: string };
  violations: unknown[];
  incomplete: unknown[];
  passes: unknown[];
  inapplicable: unknown[];
  toolOptions: unknown;
};

const DOM_KEY = /^([a-z][a-z0-9-]*)\[(\d+)\]$/;
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

function truncate(text: string, max: number, label: string): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated at ${label}]` : text;
}

/** A node axe reported inside a shadow root or an iframe: described from axe's own data, never queried. */
function domOnlyDescriptor(key: string, html: string): NodeDescriptor {
  return { selector: key, tag: "unknown", attrs: {}, text: "", domTagIndex: -1, domTagCount: 0, htmlSnippet: collapse(html).slice(0, 400), rect: { x: 0, y: 0, width: 0, height: 0 }, dataSource: null };
}

async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The keyboard walk (spec 5.3, KBD-01): starts from the state after load (nothing focused; the audit never
 * calls focus() or blur()), presses Tab and captures the active element after each press. Stops on body, on a
 * cycle (back to step 0's element after leaving it), on a trap (trapRepeats identical plain steps) or at
 * maxTabs or 20 s.
 */
async function walkKeyboard(page: Page, profile: AuditProfile): Promise<TraversalTrace> {
  const { maxTabs, trapRepeats } = profile.keyboard;
  const deadline = performance.now() + LIMITS.keyboardMs;
  const steps: TraversalStep[] = [];
  let stoppedBecause: TraversalTrace["stoppedBecause"] = "max-tabs";
  for (let i = 0; i < maxTabs && performance.now() < deadline; i++) {
    await page.keyboard.press("Tab");
    const captured = await page.evaluate(traversalStep);
    if (captured === null) {
      stoppedBecause = "body";
      break;
    }
    const previous = steps.at(-1);
    if (steps.length > 0 && captured.selector === steps[0]!.selector && previous!.selector !== captured.selector) {
      stoppedBecause = "cycle";
      break;
    }
    steps.push({ index: steps.length, ...captured });
    const tail = steps.slice(-trapRepeats);
    if (tail.length === trapRepeats && tail.every((s) => s.selector === captured.selector && s.hostKind === "plain")) {
      stoppedBecause = "trap";
      break;
    }
  }
  const reachedSelectors = new Set(steps.map((s) => s.selector));
  const candidates = (await page.evaluate(interactiveCandidates)).map((c) => ({
    selector: c.selector,
    tag: c.tag,
    reason: c.reason,
    focusable: c.focusable,
    reached: reachedSelectors.has(c.selector),
    hasFocusableDescendant: c.hasFocusableDescendant,
  }));
  return { steps, stoppedBecause, interactiveCandidates: candidates };
}

export function createPlaywrightRunner(options: PlaywrightRunnerOptions): AuditRunner {
  const { executablePath, outDir, logger } = options;
  const axe = options.axe ?? installedAxe();
  let browserPromise: Promise<Browser> | null = null;

  const browser = (): Promise<Browser> => {
    browserPromise ??= chromium.launch({ executablePath, headless: true }).catch((error: unknown) => {
      browserPromise = null;
      throw new AppError("NO_BROWSER", `${noBrowserMessage()}. Launching ${executablePath} failed`, { cause: error instanceof Error ? error.message : String(error) });
    });
    return browserPromise;
  };

  async function runAxe(page: Page, profile: AuditProfile, url: string): Promise<AxeRunResults> {
    await page.evaluate(axe.source); // evaluation, not a script tag: a page CSP cannot block it (AUD-09)
    const run = page.evaluate(
      (opts) => (window as unknown as { axe: { run(context: Document, o: unknown): Promise<unknown> } }).axe.run(document, opts),
      axeRunOptions(profile.axeTags),
    ) as Promise<AxeRunResults>;
    const results = await withTimeout(run, LIMITS.axeMs, () => new AppError("PAGE_LOAD_FAILED", `axe did not finish within 30 s: ${url}`));
    if (results.testEngine.version !== axe.version) {
      throw new AppError("AXE_VERSION_MISMATCH", `axe reported ${results.testEngine.version} but axe-core ${axe.version} is installed`);
    }
    return results;
  }

  async function describeAxeNodes(page: Page, results: AxeRawResult[]): Promise<Record<string, NodeDescriptor>> {
    const nodes: Record<string, NodeDescriptor> = {};
    let count = 0;
    for (const result of results) {
      for (const node of result.nodes) {
        const key = JSON.stringify(node.target);
        if (key in nodes) continue;
        if (count >= LIMITS.nodes) return nodes;
        count++;
        const domOnly = node.target.length > 1 || node.target.some(Array.isArray);
        const described = domOnly ? null : await page.evaluate(describeNode, node.target[0] as string);
        nodes[key] = described ? { ...described, selector: key } : domOnlyDescriptor(key, node.html);
      }
    }
    return nodes;
  }

  async function ariaByNodeOf(page: Page, keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of keys.slice(0, LIMITS.ariaNodes)) {
      const m = DOM_KEY.exec(key);
      if (!m) {
        logger.warn("watch_key_invalid", { key });
        continue;
      }
      try {
        const text = await page.locator(m[1]!).nth(Number(m[2])).ariaSnapshot({ timeout: LIMITS.ariaNodeTimeoutMs });
        out[key] = truncate(text, LIMITS.ariaNodeChars, "4 KB");
      } catch {
        out[key] = ""; // hidden or missing node
      }
    }
    return out;
  }

  async function audit(target: AuditTarget, profile: AuditProfile, opts: AuditOptions = {}): Promise<AuditSnapshot> {
    const started = performance.now();
    const origin = new URL(target.url).origin;
    const tree = treeSha256(target.servedRoot);
    const context = await (await browser()).newContext({
      viewport: profile.viewport,
      reducedMotion: "reduce",
      colorScheme: "light",
      serviceWorkers: "block",
    });
    try {
      // Only the exact origin of the tool's own server is reachable (AUD-08).
      await context.route("**/*", (route) => {
        const url = route.request().url();
        let requestOrigin = "null";
        try {
          requestOrigin = new URL(url).origin;
        } catch {
          // an unparsable URL is never the server origin
        }
        if (requestOrigin === origin) return route.continue();
        logger.debug("request_blocked", { url });
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket(
        (url) => url.origin !== origin,
        (ws) => {
          logger.debug("websocket_closed", { url: ws.url() });
          void ws.close();
        },
      );
      const page = await context.newPage();

      let response;
      try {
        response = await page.goto(target.url, { waitUntil: "load", timeout: LIMITS.loadMs });
      } catch (error) {
        throw new AppError("PAGE_LOAD_FAILED", `Page did not load within 15 s: ${target.url}`, { cause: error instanceof Error ? error.message : String(error) });
      }
      if (response !== null && response.status() >= 400) {
        throw new AppError("PAGE_LOAD_FAILED", `Page ${target.url} returned HTTP ${response.status()}`, { status: response.status() });
      }
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const loaded = performance.now();

      const results = await runAxe(page, profile, target.url);
      const violations = results.violations.map((r) => axeRawResultSchema.parse(r));
      const incomplete = results.incomplete.map((r) => axeRawResultSchema.parse(r));
      const axeDone = performance.now();

      const nodes = await describeAxeNodes(page, [...violations, ...incomplete]);
      const domIds = (await page.evaluate(collectIds)).sort();
      const title = await page.title();
      const lang = await page.evaluate(() => document.documentElement.getAttribute("lang"));

      const flaggedKeys = Object.values(nodes).filter((d) => d.tag !== "unknown" && d.domTagIndex >= 0).map(domKey);
      const ariaKeys = [...new Set([...flaggedKeys, ...target.watch])].sort();
      const ariaSnapshot = truncate(await page.locator("body").ariaSnapshot(), LIMITS.ariaBodyChars, "200 KB");
      const ariaByNode = await ariaByNodeOf(page, ariaKeys);

      let fullPage = "";
      if (opts.screenshot !== undefined && outDir !== null) {
        mkdirSync(join(outDir, "screenshots"), { recursive: true });
        // caret: "initial": the default "hide" sets an inline caret color on every input and leaves style="" behind,
        // which changes the attributes (and so the signatures and fingerprints) of the nodes described after it.
        await page.screenshot({ fullPage: true, animations: "disabled", caret: "initial", path: join(outDir, "screenshots", opts.screenshot) });
        fullPage = `screenshots/${opts.screenshot}`;
      }

      // The keyboard walk runs last: it moves focus, which must not affect the screenshot or the aria snapshots.
      const keyboardStarted = performance.now();
      const traversal = await walkKeyboard(page, profile);
      const keyboardDone = performance.now();
      const keyedSelectors = [...traversal.steps.map((s) => s.selector), ...traversal.interactiveCandidates.map((c) => c.selector)];
      for (const selector of keyedSelectors) {
        if (selector in nodes || Object.keys(nodes).length >= LIMITS.nodes) continue;
        const described = await page.evaluate(describeNode, selector);
        if (described) nodes[selector] = described;
      }

      const snapshot: AuditSnapshot = auditSnapshotSchema.parse({
        schemaVersion: 1,
        axeVersion: results.testEngine.version,
        treeSha256: tree,
        url: target.url,
        pagePath: target.pagePath,
        title,
        lang,
        axe: { violations, incomplete, passesCount: results.passes.length, inapplicableCount: results.inapplicable.length, toolOptions: results.toolOptions },
        nodes,
        domIds,
        traversal,
        ariaSnapshot,
        ariaByNode,
        screenshots: { fullPage },
        timings: { loadMs: Math.round(loaded - started), axeMs: Math.round(axeDone - loaded), keyboardMs: Math.round(keyboardDone - keyboardStarted) },
      });
      logger.info("audit_done", {
        url: target.url,
        axeVersion: snapshot.axeVersion,
        violations: violations.reduce((n, r) => n + r.nodes.length, 0),
        incomplete: incomplete.reduce((n, r) => n + r.nodes.length, 0),
        keyboard: analyzeKeyboard(traversal, profile.keyboard).length,
        ms: Math.round(performance.now() - started),
      });
      return snapshot;
    } finally {
      await context.close();
    }
  }

  return {
    audit,
    async close(): Promise<void> {
      const pending = browserPromise;
      browserPromise = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
  };
}
