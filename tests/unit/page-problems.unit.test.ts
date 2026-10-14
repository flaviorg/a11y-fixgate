// collectPageProblems (tests/helpers/page-problems.ts): what an e2e test learns when a page misbehaves. A failure has to
// name the resource: "Failed to load resource ... 404" alone cost a CI round trip to trace back to /favicon.ico.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { collectPageProblems } from "../helpers/page-problems.ts";

const URL_OF_PAGE = "http://127.0.0.1:4321/report.html";
const emitter = (): { page: Page; emit: (event: string, payload: unknown) => void } => {
  const events = new EventEmitter();
  return { page: events as unknown as Page, emit: (event, payload) => void events.emit(event, payload) };
};
const consoleMessage = (type: string, text: string, url = "") => ({ type: () => type, text: () => text, location: () => ({ url, lineNumber: 0, columnNumber: 0 }) });

test("[CS-6] a console error names the URL of the resource it is about, taken from the message location", () => {
  const { page, emit } = emitter();
  const problems = collectPageProblems(page);
  emit("console", consoleMessage("error", "Failed to load resource: the server responded with a status of 404 (Not Found)", "http://127.0.0.1:4321/favicon.ico"));
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^error: Failed to load resource: .*404 \(Not Found\)/);
  assert.ok(problems[0]!.includes("http://127.0.0.1:4321/favicon.ico"), problems[0]!);
});

test("[CS-6] console warnings are kept, other console types are ignored, and a message without a location adds no empty URL", () => {
  const { page, emit } = emitter();
  const problems = collectPageProblems(page);
  emit("console", consoleMessage("log", "hello", URL_OF_PAGE));
  emit("console", consoleMessage("info", "hello", URL_OF_PAGE));
  emit("console", consoleMessage("debug", "hello", URL_OF_PAGE));
  emit("console", consoleMessage("warning", "careful"));
  assert.deepEqual(problems, ["warning: careful"]);
});

test("[CS-6] a response with status 400 or more is recorded with its status and URL, a successful one is not", () => {
  const { page, emit } = emitter();
  const problems = collectPageProblems(page);
  emit("response", { status: () => 200, url: () => URL_OF_PAGE });
  emit("response", { status: () => 304, url: () => "http://127.0.0.1:4321/screenshots/page.png" });
  emit("response", { status: () => 399, url: () => "http://127.0.0.1:4321/redirect" });
  assert.deepEqual(problems, []);
  emit("response", { status: () => 404, url: () => "http://127.0.0.1:4321/screenshots/page.png" });
  emit("response", { status: () => 500, url: () => "http://127.0.0.1:4321/api" });
  assert.deepEqual(problems, ["http 404: http://127.0.0.1:4321/screenshots/page.png", "http 500: http://127.0.0.1:4321/api"]);
});

test("[CS-6] a failed request and an uncaught page error are recorded with the URL or the message", () => {
  const { page, emit } = emitter();
  const problems = collectPageProblems(page);
  emit("requestfailed", { url: () => "https://cdn.example.test/lib.js", failure: () => ({ errorText: "net::ERR_BLOCKED_BY_CLIENT" }) });
  emit("requestfailed", { url: () => "http://127.0.0.1:4321/x.png", failure: () => null });
  emit("pageerror", new Error("boom"));
  assert.deepEqual(problems, [
    "requestfailed: https://cdn.example.test/lib.js (net::ERR_BLOCKED_BY_CLIENT)",
    "requestfailed: http://127.0.0.1:4321/x.png (unknown failure)",
    "pageerror: boom",
  ]);
});
