// @vitest-environment jsdom
//
// The intake chip renders what the API now scopes per viewer: staff get the
// score (and the reason as a tooltip); everyone else gets the outcome alone.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/test-org/feedback",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
// SSE EventSource jsdom lacks — the live-refresh subscription (COSMOS-129) is
// orthogonal to what these tests exercise, so stub it to a no-op.
vi.mock("@/hooks/use-realtime-events", () => ({ useRealtimeEvents: () => {} }));
// The submit dialog's project picker fetches via jsonFetch; the detail flow
// doesn't need projects, so an empty list keeps that query quiet.
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve([])),
}));

import { FeedbackPortal } from "./feedback-portal";

const base = {
  id: "fr-1",
  type: "FEATURE" as const,
  title: "Held request",
  description: "",
  status: "OPEN" as const,
  voteCount: 0,
  hasVoted: false,
  isMine: false,
  createdAt: "2026-07-01T12:00:00.000Z",
  attachments: [],
  authorName: "Ada",
};

function renderWith(intake: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ ...base, intake }] }) as Response),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FeedbackPortal orgId="org-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FeedbackPortal — intake chip", () => {
  it("shows staff the score, with the reason as its tooltip", async () => {
    renderWith({ state: "held", label: "Held for review", score: 0.5, reason: "judge: possible injection" });

    const chip = await screen.findByText("Held for review · 0.50");
    expect(chip.closest("[title]")?.getAttribute("title")).toBe("judge: possible injection");
  });

  it("shows everyone else the outcome alone: no score, no tooltip", async () => {
    renderWith({ state: "held", label: "Held for review", score: null });

    const chip = await screen.findByText("Held for review");
    expect(chip.textContent).toBe("Held for review");
    expect(chip.closest("[title]")).toBeNull();
  });
});
