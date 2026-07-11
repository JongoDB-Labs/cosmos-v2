// @vitest-environment jsdom
//
// COSMOS-99 — the notifications feed used to render `notifications.slice(0, 10)`
// inside a fixed dropdown, so historical items were unreachable. These tests
// lock the fix at the component level: every fetched notification renders (no
// client-side cap), and the per-row read/unread + dismiss controls hit the
// right endpoints.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotificationDropdown } from "./notification-dropdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/acme/dashboard",
}));

// jsdom lacks EventSource / ResizeObserver that base-ui's popover + the SSE
// subscription reach for.
class FakeEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function notif(i: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `n${i}`,
    orgId: "o1",
    userId: "u1",
    type: "comment.added",
    title: `Notification ${i}`,
    body: `Body ${i}`,
    refType: null,
    refId: null,
    read: false,
    url: `/notes/${i}`,
    createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Default GET: 15 unread notifications, no further page.
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const items = Array.from({ length: 15 }, (_, i) => notif(i + 1));
      return new Response(
        JSON.stringify({ items, nextCursor: null, unreadCount: 15 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openFeed() {
  render(<NotificationDropdown orgId="o1" />);
  // Wait for the initial fetch to resolve (badge reflects unreadCount).
  await screen.findByText("9+");
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
}

describe("NotificationDropdown", () => {
  it("renders every fetched notification (no 10-item cap)", async () => {
    await openFeed();
    // The original bug capped the list at 10; all 15 must be present now.
    const rows = await screen.findAllByText(/^Notification \d+$/);
    expect(rows).toHaveLength(15);
    expect(screen.getByText("Notification 15")).toBeInTheDocument();
  });

  it("filters by category, refetching with the category param", async () => {
    await openFeed();
    await screen.findByText("Notification 1");

    fireEvent.click(screen.getByRole("button", { name: "Mentions" }));

    await waitFor(() => {
      const called = fetchMock.mock.calls.some(([u]) =>
        String(u).includes("category=mention"),
      );
      expect(called).toBe(true);
    });
  });

  it("dismisses a notification via DELETE on its id", async () => {
    await openFeed();
    await screen.findByText("Notification 1");

    const dismissButtons = screen.getAllByRole("button", {
      name: "Dismiss notification",
    });
    fireEvent.click(dismissButtons[0]);

    await waitFor(() => {
      const deleted = fetchMock.mock.calls.some(
        ([u, init]) =>
          String(u).includes("/notifications/n1") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      );
      expect(deleted).toBe(true);
    });
  });

  it("marks all read via POST and clears the badge", async () => {
    await openFeed();
    await screen.findByText("Notification 1");

    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.some(
        ([u, init]) =>
          String(u).endsWith("/notifications") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBe(true);
    });
    await waitFor(() => expect(screen.queryByText("9+")).not.toBeInTheDocument());
  });
});
