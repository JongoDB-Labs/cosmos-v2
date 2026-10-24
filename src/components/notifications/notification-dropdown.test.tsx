// @vitest-environment jsdom
//
// The notifications bell button must expose an accessible name so screen-reader
// users can find it. Proves:
//   - the trigger button always has an aria-label of "Notifications";
//   - once unread notifications load, the label folds in the unread count
//     (e.g. "Notifications, 2 unread") so the badge count is announced too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { NotificationDropdown } from "./notification-dropdown";
import type { Notification } from "@/types/models";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/acme",
}));

// jsdom has no EventSource; the component opens one for live updates.
class FakeEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const ORG_ID = "org-123";

function notif(id: string, read: boolean): Notification {
  return {
    id,
    orgId: ORG_ID,
    userId: "u1",
    type: "generic",
    title: `Title ${id}`,
    body: `Body ${id}`,
    refType: null,
    refId: null,
    read,
    url: null,
    createdAt: new Date(0).toISOString(),
  };
}

type Page = {
  data: Notification[];
  nextCursor: string | null;
  unread?: number;
};

/** The bell reads the paged inbox endpoint; answer by cursor. */
function mockInbox(pages: Record<string, Page>) {
  const fetchMock = vi.fn(async (url: string) => {
    const cursor = new URL(url, "http://x").searchParams.get("cursor") ?? "";
    const p = pages[cursor];
    if (!p) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        data: p.data,
        nextCursor: p.nextCursor,
        counts: { unread: p.unread ?? p.data.filter((n) => !n.read).length },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFetch(body: Notification[]) {
  return mockInbox({ "": { data: body, nextCursor: null } });
}

const many = (prefix: string, n: number, read = true) =>
  Array.from({ length: n }, (_, i) => notif(`${prefix}${i + 1}`, read));

async function openBell() {
  const trigger = await screen.findByRole("button", { name: /^Notifications/ });
  fireEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationDropdown bell button", () => {
  it('exposes an accessible name of "Notifications" before anything loads', () => {
    mockFetch([]);
    render(<NotificationDropdown orgId={ORG_ID} />);
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });

  it("includes the unread count in the accessible name once unread notifications load", async () => {
    mockFetch([notif("a", false), notif("b", false), notif("c", true)]);
    render(<NotificationDropdown orgId={ORG_ID} />);
    // Two of the three are unread → "Notifications, 2 unread".
    expect(
      await screen.findByRole("button", { name: "Notifications, 2 unread" }),
    ).toBeInTheDocument();
  });
});

describe("NotificationDropdown feed", () => {
  it("badges the whole inbox's unread count, not just the loaded rows", async () => {
    mockInbox({
      "": {
        data: [notif("a", false), notif("b", true)],
        nextCursor: "c1",
        unread: 37,
      },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    expect(
      await screen.findByRole("button", { name: "Notifications, 37 unread" }),
    ).toBeInTheDocument();
  });

  it("shows the whole first page, not the first ten", async () => {
    mockInbox({ "": { data: many("n", 20), nextCursor: null } });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    expect(await screen.findByText("Title n20")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(20);
    expect(screen.getByText("No older notifications")).toBeInTheDocument();
  });

  it("loads the next page from the cursor, and stops at the end", async () => {
    const fetchMock = mockInbox({
      "": { data: many("p1-", 20), nextCursor: "c1" },
      c1: { data: many("p2-", 5), nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Title p2-5")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(25);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("cursor=c1")),
    ).toBe(true);
    expect(screen.getByText("No older notifications")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("loads the next page by itself when the foot of the list scrolls into view", async () => {
    class SeeingObserver {
      constructor(private cb: IntersectionObserverCallback) {}
      observe() {
        this.cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as never,
        );
      }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", SeeingObserver);
    mockInbox({
      "": { data: many("p1-", 20), nextCursor: "c1" },
      c1: { data: many("p2-", 3), nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    expect(await screen.findByText("Title p2-3")).toBeInTheDocument();
  });

  it("keeps the badge steady as older unread pages load", async () => {
    mockInbox({
      "": {
        data: [notif("a", false), notif("b", false)],
        nextCursor: "c1",
        unread: 5,
      },
      c1: {
        data: [notif("c", false), notif("d", false), notif("e", false)],
        nextCursor: null,
      },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    await screen.findByText("Title e");
    expect(
      screen.getByRole("button", { name: "Notifications, 5 unread" }),
    ).toBeInTheDocument();
  });

  it("says so when an older page fails, and lets you try again", async () => {
    mockInbox({ "": { data: many("p1-", 20), nextCursor: "gone" } });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Couldn't load older notifications. Try again",
        }),
      ).toBeEnabled(),
    );
  });
});
