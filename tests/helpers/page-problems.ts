// What an e2e test learns when a page misbehaves: console errors and warnings, uncaught page errors, HTTP errors and
// failed requests, each with the URL of the resource. A bare "Failed to load resource ... 404" names nothing, and Chromium
// reports its own /favicon.ico request only through the console message location (no "response" event), so the location
// URL is part of the text.
import type { Page } from "playwright-core";

/** Starts listening on the page; the returned array fills up while the test runs. */
export function collectPageProblems(page: Pick<Page, "on">): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning") return;
    const url = m.location().url;
    problems.push(`${type}: ${m.text()}${url ? ` [${url}]` : ""}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
  });
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()} (${r.failure()?.errorText ?? "unknown failure"})`));
  return problems;
}
