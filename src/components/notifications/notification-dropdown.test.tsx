// @vitest-environment jsdom
//
// The notifications bell button must expose an accessible name so screen-reader
// users can find it. Proves:
//   - the trigger button always has an aria-label of "Notifications";
//   - once unread notifications load, the label folds in the unread count
//     (e.g. "Notifications, 2 unread") so the badge count is announced too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

function mockFetch(body: Notification[]) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
