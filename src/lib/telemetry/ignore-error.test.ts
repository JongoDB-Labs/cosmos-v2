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
