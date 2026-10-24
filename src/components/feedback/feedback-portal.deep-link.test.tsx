// @vitest-environment jsdom
//
// `/feedback?item=<id>`: every feedback notification now links to the item
// itself. The board opens it (even when it is outside the list's top 200),
// keeps it open through a live refetch, and says so when it cannot.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  cleanup,
  act,
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

// Behaves like the app router: one stable router, and replace() really changes
// what useSearchParams returns on the next render.
const nav = vi.hoisted(() => {
  const state = {
    params: new URLSearchParams(),
    replace: vi.fn((url: string) => {
      state.params = new URLSearchParams(new URL(url, "http://x").search);
    }),
    handlers: {} as Record<string, () => void>,
  };
  return state;
});
const router = { replace: (url: string) => nav.replace(url) };
vi.mock("next/navigation", () => ({
  usePathname: () => "/test-org/feedback",
  useRouter: () => router,
  useSearchParams: () => nav.params,
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-realtime-events", () => ({
  // Several components subscribe (the portal and the open item's thread).
  useRealtimeEvents: (_org: string, handlers: Record<string, () => void>) => {
    Object.assign(nav.handlers, handlers);
  },
}));
const { jsonFetch, FetchErrorMock } = vi.hoisted(() => {
  class FetchErrorMock extends Error {
    constructor(public status: number) {
      super(`HTTP ${status}`);
    }
  }
  return { jsonFetch: vi.fn(), FetchErrorMock };
});
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch, FetchError: FetchErrorMock }));

import { FeedbackPortal } from "./feedback-portal";

const OLD_FR = {
  id: "fr-old",
  type: "FEATURE" as const,
  title: "An old request outside the top 200",
  description: "Still worth discussing.",
  status: "PLANNED" as const,
  voteCount: 1,
  hasVoted: false,
  isMine: false,
  createdAt: "2026-01-01T12:00:00.000Z",
  attachments: [],
  authorName: "Ada Lovelace",
};

const renderPortal = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FeedbackPortal orgId="org-1" />
    </QueryClientProvider>,
  );

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockClear();
  window.history.replaceState(null, "", "/test-org/feedback");
  // The list (raw fetch) never contains the deep-linked item.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as Response));
  jsonFetch.mockImplementation((url: string) =>
    url.endsWith("/feedback/fr-old") ? Promise.resolve(OLD_FR) : Promise.resolve([]),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FeedbackPortal — ?item= deep link", () => {
  it("opens an item that is not in the list, then strips the param", async () => {
    nav.params = new URLSearchParams("item=fr-old");
    window.history.replaceState(null, "", "/test-org/feedback?item=fr-old");
    renderPortal();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("An old request outside the top 200")).toBeInTheDocument();
    expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/org-1/feedback/fr-old");
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(String(nav.replace.mock.calls[0][0])).not.toContain("item=");
  });

  it("keeps the linked item open when the list refetches live", async () => {
    nav.params = new URLSearchParams("item=fr-old");
    renderPortal();
    await screen.findByRole("dialog");

    await act(async () => {
      nav.handlers["work-item.created"]();
    });

    expect(within(screen.getByRole("dialog")).getByText("An old request outside the top 200")).toBeInTheDocument();
  });

  it("says so when the item cannot be opened, the same way for missing and forbidden", async () => {
    jsonFetch.mockImplementation((url: string) =>
      url.includes("/feedback/") ? Promise.reject(new FetchErrorMock(403)) : Promise.resolve([]),
    );
    nav.params = new URLSearchParams("item=fr-secret");
    renderPortal();

    expect(
      await screen.findByText("That feedback no longer exists, or you don't have access to it."),
    ).toBeInTheDocument();
  });

  it("keeps the #c- hash, so the thread can find the linked comment", async () => {
    nav.params = new URLSearchParams("item=fr-old");
    window.history.replaceState(null, "", "/test-org/feedback?item=fr-old#c-abc");
    renderPortal();

    await screen.findByRole("dialog");
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(nav.replace.mock.calls[0][0]).toBe("/test-org/feedback#c-abc");
  });
});


describe("FeedbackPortal — a merged request", () => {
  const MERGED = { ...OLD_FR, id: "fr-dup", title: "Night colours please", status: "MERGED" as const, mergedIntoId: "fr-main" };
  const MAIN = { ...OLD_FR, id: "fr-main", title: "Dark mode", status: "OPEN" as const, mergedIntoId: null };

  it("can't be voted on, and links to the request it was merged into", async () => {
    jsonFetch.mockImplementation((url: string) =>
      url.endsWith("/feedback/fr-dup")
        ? Promise.resolve(MERGED)
        : url.endsWith("/feedback/fr-main")
          ? Promise.resolve(MAIN)
          : Promise.resolve([]),
    );
    nav.params = new URLSearchParams("item=fr-dup");
    renderPortal();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Upvote/ })).toBeDisabled();
    const link = await within(dialog).findByRole("button", { name: "Dark mode" });
    act(() => link.click());
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Dark mode" })).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: /Upvote/ })).toBeEnabled();
  });
});
