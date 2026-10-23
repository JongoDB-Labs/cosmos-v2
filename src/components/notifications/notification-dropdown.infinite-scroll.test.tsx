// @vitest-environment jsdom
//
// COSMOS-214 — the notifications feed must reach history past the first screen.
//
// The bell fetched `?limit=10` and rendered `notifications.slice(0, 10)` into a
// panel with no list-level scroll region, so notification eleven was simply
// unreachable from the bell. These lock the replacement:
//   - the first page is a page (25), not ten, and lands in a scrollable region;
//   - reaching the foot of that region auto-fetches the NEXT page with a
//     `cursor` and APPENDS it — no button, no navigation;
//   - a short page ends the feed: the sentinel goes away and the list says so.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NotificationDropdown } from "./notification-dropdown";
import type { Notification } from "@/types/models";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/acme",
}));

// --- base-ui needs these in jsdom (see src/components/ui/action-menu.test.tsx)
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

class FakeEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

// --- a steerable IntersectionObserver: jsdom has none, and "the sentinel came
// into view" is exactly the event under test. ---------------------------------
type IOCallback = (entries: { isIntersecting: boolean }[]) => void;
let live: { cb: IOCallback; el: Element }[] = [];

class FakeIntersectionObserver {
  constructor(private cb: IOCallback) {}
  observe(el: Element) {
    live.push({ cb: this.cb, el });
  }
  unobserve(el: Element) {
    live = live.filter((o) => o.el !== el);
  }
  disconnect() {
    live = live.filter((o) => o.cb !== this.cb);
  }
  takeRecords() {
    return [];
  }
}

/** Scroll the sentinel into view, as a user reaching the foot of the list does. */
function reachFootOfList() {
  expect(live.length).toBeGreaterThan(0);
  live[live.length - 1].cb([{ isIntersecting: true }]);
}

const ORG_ID = "org-123";
const PAGE_SIZE = 25;
const TOTAL = 30;
const BASE = Date.parse("2026-10-20T12:00:00.000Z");

// Newest first, one minute apart — the ordering the endpoint promises.
const ALL: Notification[] = Array.from({ length: TOTAL }, (_, i) => ({
  id: `n${i}`,
  orgId: ORG_ID,
  userId: "u1",
  type: "generic",
  title: `Title ${i}`,
  body: `Body ${i}`,
  refType: null,
  refId: null,
  read: true,
  url: null,
  createdAt: new Date(BASE - i * 60_000).toISOString(),
}));

const urls: string[] = [];

/** The real endpoint's contract: a bare array, `limit` rows, older than `cursor`. */
function mockPagedFetch() {
  const fetchMock = vi.fn(async (input: string) => {
    urls.push(input);
    const url = new URL(input, "http://localhost");
    const cursor = url.searchParams.get("cursor");
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : TOTAL;
    const older = cursor
      ? ALL.filter((n) => Date.parse(n.createdAt) < Date.parse(cursor))
      : ALL;
    return { ok: true, json: async () => older.slice(0, limit) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function openBell() {
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  live = [];
  urls.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationDropdown feed pagination", () => {
  it("shows a whole first page in a scrollable region, not ten items", async () => {
    mockPagedFetch();
    render(<NotificationDropdown orgId={ORG_ID} />);

    // Item 24 is past the old ten-item cap; it must be there from the first page.
    openBell();
    expect(await screen.findByText("Title 24")).toBeInTheDocument();
    expect(screen.getByText("Title 0")).toBeInTheDocument();
    expect(screen.getAllByText(/^Title \d+$/)).toHaveLength(PAGE_SIZE);

    // …and in a region that actually scrolls, so the panel doesn't just grow.
    const feed = screen.getByLabelText("Notifications feed");
    expect(feed.className).toContain("overflow-y-auto");
    expect(feed.className).toContain("max-h-80");

    expect(urls[0]).toContain(`limit=${PAGE_SIZE}`);
    expect(urls[0]).not.toContain("cursor=");
  });

  it("auto-loads and appends the next page when the foot of the list is reached", async () => {
    mockPagedFetch();
    render(<NotificationDropdown orgId={ORG_ID} />);
    openBell();
    await screen.findByText("Title 24");

    // Nothing beyond the first page yet.
    expect(screen.queryByText("Title 25")).not.toBeInTheDocument();

    reachFootOfList();

    // The remaining five arrive, appended under the first page — and the first
    // page is still there, so this is a feed, not a replacement.
    expect(await screen.findByText("Title 29")).toBeInTheDocument();
    expect(screen.getByText("Title 0")).toBeInTheDocument();
    expect(screen.getAllByText(/^Title \d+$/)).toHaveLength(TOTAL);

    // Paged with the oldest row we held as the cursor, not an offset guess.
    const second = urls.find((u) => u.includes("cursor="));
    expect(second).toBeDefined();
    expect(second).toContain(
      `cursor=${encodeURIComponent(ALL[PAGE_SIZE - 1].createdAt)}`,
    );
  });

  it("stops at the end of history instead of asking forever", async () => {
    mockPagedFetch();
    render(<NotificationDropdown orgId={ORG_ID} />);
    openBell();
    await screen.findByText("Title 24");

    reachFootOfList();
    await screen.findByText("Title 29");

    // A short page is the end: say so, and stop observing for more.
    expect(await screen.findByText("No older notifications")).toBeInTheDocument();
    expect(live).toHaveLength(0);

    const pageRequests = urls.filter((u) => u.includes("limit="));
    expect(pageRequests).toHaveLength(2);
  });
});
