import { describe, it, expect } from "vitest";

import {
  isReportableClientError,
  isViewTransitionAbort,
} from "./ignore-error";

/**
 * COSMOS-237. Verbatim from the filed report: a member navigated quickly on a
 * board route, Chrome skipped the in-flight `<PageTransition>` animation in
 * favour of the newer one, and the resulting `AbortError` — raised inside the
 * browser's transition machinery, so stackless — reached the app's
 * `unhandledrejection` handler and was filed as a BUG.
 */
const SKIPPED_TRANSITION = "Transition was skipped. New ViewTransition started";

describe("isViewTransitionAbort", () => {
  it("matches the message a rapid board navigation actually filed", () => {
    expect(isViewTransitionAbort(SKIPPED_TRANSITION)).toBe(true);
  });

  it.each([
    ["AbortError prefix", "AbortError: Transition was skipped. New ViewTransition started"],
    ["hidden document", "Transition was skipped because document visibility state is hidden"],
    ["invalid state", "Transition was aborted because of invalid state"],
    ["WebKit wording", "Skipping view transition because a new one was started"],
    ["spaced spelling", "View Transition was skipped"],
  ])("matches the %s variant", (_label, message) => {
    expect(isViewTransitionAbort(message)).toBe(true);
  });

  it("does not match an ordinary error, a CSS transition, or an absent message", () => {
    expect(isViewTransitionAbort("Cannot read properties of undefined")).toBe(false);
    expect(isViewTransitionAbort("Board transition failed to save")).toBe(false);
    expect(isViewTransitionAbort(undefined)).toBe(false);
    expect(isViewTransitionAbort("")).toBe(false);
  });
});

describe("isReportableClientError — interrupted View Transitions", () => {
  it("does not offer a bug report for a skipped View Transition", () => {
    expect(isReportableClientError(SKIPPED_TRANSITION)).toBe(false);
  });

  it("ignores it even when the browser attaches a stack", () => {
    expect(
      isReportableClientError(
        SKIPPED_TRANSITION,
        "AbortError: Transition was skipped. New ViewTransition started\n    at https://cosmos.example.com/_next/static/chunks/app/page.js:1:2",
      ),
    ).toBe(false);
  });

  it("still reports a genuine board error raised during a navigation", () => {
    expect(
      isReportableClientError(
        "Cannot read properties of undefined (reading 'columns')",
        "TypeError: Cannot read properties of undefined\n    at ProjectBoard (https://cosmos.example.com/_next/static/chunks/board.js:1:2)",
      ),
    ).toBe(true);
  });
});
