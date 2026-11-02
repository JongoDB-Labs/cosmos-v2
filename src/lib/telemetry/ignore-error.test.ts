import { describe, it, expect } from "vitest";

import {
  isBrowserExtensionError,
  isChunkLoadError,
  isReportableClientError,
} from "./ignore-error";

/**
 * COSMOS-172. Verbatim from the filed report: a MetaMask page script failed its
 * own automatic session restore on a dashboard route, the rejection surfaced on
 * the app's `unhandledrejection` handler, and a member was offered — and sent —
 * a bug report for an app that has no wallet integration at all.
 */
const METAMASK_MESSAGE = "Failed to connect to MetaMask";
const METAMASK_STACK = [
  "i: Failed to connect to MetaMask",
  "    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:7:84292)",
].join("\n");

describe("isReportableClientError", () => {
  it("does not offer a bug report for a MetaMask session-restore failure", () => {
    expect(isReportableClientError(METAMASK_MESSAGE, METAMASK_STACK)).toBe(false);
  });

  it("still offers a bug report for a genuine app error", () => {
    expect(
      isReportableClientError(
        "Cannot read properties of undefined (reading 'length')",
        "TypeError: Cannot read properties of undefined\n    at ProjectBoard (https://cosmos.example.com/_next/static/chunks/app/page.js:1:2)",
      ),
    ).toBe(true);
  });

  it("offers a bug report for an app error with no stack at all", () => {
    expect(isReportableClientError("Something blew up")).toBe(true);
  });

  it("ignores chunk-load errors, which ChunkReloadGuard recovers", () => {
    expect(isReportableClientError("ChunkLoadError: Loading chunk 42 failed")).toBe(
      false,
    );
  });

  it("ignores an empty message", () => {
    expect(isReportableClientError(undefined)).toBe(false);
    expect(isReportableClientError("")).toBe(false);
  });
});

describe("isBrowserExtensionError", () => {
  it.each([
    ["chrome", "at connect (chrome-extension://abc/inpage.js:1:1)"],
    ["firefox", "at connect (moz-extension://abc/inpage.js:1:1)"],
    ["safari", "at connect (safari-web-extension://abc/inpage.js:1:1)"],
    ["edge", "at connect (ms-browser-extension://abc/inpage.js:1:1)"],
  ])("matches an injected %s extension frame", (_browser, stack) => {
    expect(isBrowserExtensionError("Failed to connect to MetaMask", stack)).toBe(true);
  });

  it("matches when only the message carries the extension url", () => {
    expect(
      isBrowserExtensionError(
        "Error loading chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js",
      ),
    ).toBe(true);
  });

  it("matches a Gecko/WebKit-style frame (fn@url:line:col)", () => {
    expect(
      isBrowserExtensionError("Failed to connect to MetaMask", "connect@moz-extension://abc/inpage.js:7:84292"),
    ).toBe(true);
  });

  it("does NOT match an app error that passed through an extension's fetch wrapper", () => {
    // Extensions wrap page APIs, so a real Cosmos failure can carry an
    // extension frame mid-stack. One app frame means it is ours to report.
    const stack = [
      "TypeError: Failed to fetch",
      "    at window.fetch (chrome-extension://abc/content.js:1:1)",
      "    at loadBoard (https://cosmos.example.com/_next/static/chunks/board.js:1:2)",
    ].join("\n");
    expect(isBrowserExtensionError("Failed to fetch", stack)).toBe(false);
    expect(isReportableClientError("Failed to fetch", stack)).toBe(true);
  });

  it("does not match an app stack that merely mentions an extension-like word", () => {
    expect(
      isBrowserExtensionError(
        "Unsupported file extension",
        "at upload (https://cosmos.example.com/_next/static/chunks/files.js:1:1)",
      ),
    ).toBe(false);
  });
});

describe("isChunkLoadError", () => {
  it("matches the stale-chunk signatures a deploy produces", () => {
    expect(isChunkLoadError("ChunkLoadError: Loading chunk app/page failed")).toBe(true);
    expect(
      isChunkLoadError("Failed to fetch dynamically imported module: /_next/x.js"),
    ).toBe(true);
  });

  it("does not match an ordinary error or an absent message", () => {
    expect(isChunkLoadError("Cannot read properties of undefined")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

/**
 * faecbb73 — a member was shown "Something went wrong" on a board and filed a
 * BUG ticket reading "Transition was skipped. New ViewTransition started". One
 * hit, no stack, no component stack, no breadcrumbs.
 *
 * That message is the View Transitions API working as specified: a transition's
 * promise REJECTS when a newer transition supersedes it, which rapid navigation
 * does constantly — and a board route is where rapid navigation happens. We
 * declare React's <ViewTransition> (components/ui/page-transition) but never
 * call startViewTransition, so we never hold the promise that rejects and there
 * is nothing on our side to await or cancel. Nothing is broken.
 *
 * So the cost was entirely in the reporting: a scary toast over a working page,
 * and a bug ticket in the queue the roadmap is pulled from.
 */
describe("interrupted view transitions are not bugs", () => {
  it("does not offer a bug report for the superseded-transition rejection", () => {
    expect(
      isReportableClientError("Transition was skipped. New ViewTransition started"),
    ).toBe(false);
  });

  it("covers the abort and interrupt wordings too, not just the one we saw", () => {
    // Browsers and React word this differently and have changed it before;
    // matching only the exact string seen in one report would let the next
    // phrasing straight back through.
    expect(isReportableClientError("Transition was aborted")).toBe(false);
    expect(isReportableClientError("View transition was interrupted")).toBe(false);
    expect(isReportableClientError("ViewTransition skipped")).toBe(false);
  });

  it("is not fooled into swallowing a real error that merely says 'transition'", () => {
    // The positive control, and the reason this predicate is narrow: work items
    // have status TRANSITIONS, and a genuine failure in that code says so.
    expect(
      isReportableClientError("Failed to apply transition: target column is required"),
    ).toBe(true);
    expect(isReportableClientError("TypeError: transition is not a function")).toBe(true);
  });

  it("still reports a genuine error raised DURING a transition", () => {
    // An app error with a real stack is ours whatever it coincided with.
    expect(
      isReportableClientError(
        "Cannot read properties of null (reading 'columnKey')",
        "    at KanbanCard (/_next/static/chunks/boards.js:4:11)",
      ),
    ).toBe(true);
  });
});
