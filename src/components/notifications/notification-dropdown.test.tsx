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
  act,
  within,
} from "@testing-library/react";
import { NotificationDropdown } from "./notification-dropdown";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  announceNotificationsChanged,
  onNotificationsChanged,
} from "@/lib/notifications/changed";
import type { Notification } from "@/types/models";

const { push, notifyError } = vi.hoisted(() => ({
  push: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/acme",
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError }));

// jsdom has no EventSource; the component opens one for live updates.
const sse: { emit?: (data: unknown) => void } = {};
class FakeEventSource {
  addEventListener(_name: string, fn: (ev: MessageEvent) => void) {
    sse.emit = (data) => fn({ data: JSON.stringify(data) } as MessageEvent);
  }
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
  byType?: { type: string; count: number }[];
};

/** The bell reads the paged inbox endpoint; answer by cursor. */
function mockInbox(
  pages: Record<string, Page>,
  put: { ok: boolean } = { ok: true },
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT")
      return { ok: put.ok, status: put.ok ? 200 : 500, json: async () => ({}) };
    const sp = new URL(url, "http://x").searchParams;
    const cursor =
      (sp.get("type") ? `${sp.get("type")}:` : "") + (sp.get("cursor") ?? "");
    const p = pages[cursor];
    if (!p) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        data: p.data,
        nextCursor: p.nextCursor,
        counts: {
          unread: p.unread ?? p.data.filter((n) => !n.read).length,
          byType: p.byType,
        },
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

describe("NotificationDropdown read and unread", () => {
  const putBodies = (fetchMock: ReturnType<typeof mockInbox>) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([u, init]) => [
        String(u).split("/").pop(),
        JSON.parse(String(init!.body)),
      ]);

  it("marks a read notification unread, and the badge counts it", async () => {
    const fetchMock = mockInbox({
      "": { data: [notif("a", true), notif("b", false)], nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await screen.findByRole("button", { name: "Notifications, 1 unread" });
    await openBell();
    fireEvent.click(
      screen.getByRole("button", { name: 'Mark "Title a" unread' }),
    );
    expect(
      await screen.findByRole("button", { name: "Notifications, 2 unread" }),
    ).toBeInTheDocument();
    expect(putBodies(fetchMock)).toEqual([["a", { read: false }]]);
    // The toggle flips with it, so the same button marks it read again.
    fireEvent.click(
      screen.getByRole("button", { name: 'Mark "Title a" read' }),
    );
    expect(
      await screen.findByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeInTheDocument();
    expect(putBodies(fetchMock)).toEqual([
      ["a", { read: false }],
      ["a", { read: true }],
    ]);
  });

  it("marks one read without opening it", async () => {
    const withUrl = { ...notif("a", false), url: "/issues?item=a" };
    const fetchMock = mockInbox({ "": { data: [withUrl], nextCursor: null } });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(
      await screen.findByRole("button", { name: 'Mark "Title a" read' }),
    );
    expect(
      await screen.findByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(putBodies(fetchMock)).toEqual([["a", { read: true }]]);
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the row as it was, and says so, when the server refuses", async () => {
    mockInbox(
      { "": { data: [notif("a", true)], nextCursor: null } },
      { ok: false },
    );
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(
      await screen.findByRole("button", { name: 'Mark "Title a" unread' }),
    );
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        expect.anything(),
        "Couldn't mark that unread.",
      ),
    );
    expect(
      screen.getByRole("button", { name: 'Mark "Title a" unread' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });

  it("opening an already-read notification doesn't write it again", async () => {
    const withUrl = { ...notif("a", true), url: "/issues?item=a" };
    const fetchMock = mockInbox({ "": { data: [withUrl], nextCursor: null } });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Title a/ }));
    expect(push).toHaveBeenCalledWith("/acme/issues?item=a");
    expect(putBodies(fetchMock)).toEqual([]);
  });
});

describe("NotificationDropdown clearing", () => {
  const calls = (fetchMock: ReturnType<typeof mockInbox>, method: string) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === method)
      .map(([u, init]) => [
        String(u).replace(`/api/v1/orgs/${ORG_ID}`, ""),
        init?.body ? JSON.parse(String(init.body)) : null,
      ]);

  it("clears one notification, and the badge follows", async () => {
    const fetchMock = mockInbox({
      "": { data: [notif("a", false), notif("b", false)], nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(
      await screen.findByRole("button", { name: 'Clear "Title a"' }),
    );
    await waitFor(() => expect(screen.queryByText("Title a")).toBeNull());
    expect(screen.getByText("Title b")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeInTheDocument();
    expect(calls(fetchMock, "DELETE")).toEqual([["/notifications/a", null]]);
    expect(push).not.toHaveBeenCalled();
  });

  it("clears everything only after you confirm", async () => {
    const fetchMock = mockInbox({
      "": { data: many("n", 20, false), nextCursor: "c1", unread: 30 },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: "Clear all…" }));
    expect(calls(fetchMock, "POST")).toEqual([]);
    expect(screen.getByText("Clear all?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(calls(fetchMock, "POST")).toEqual([
      ["/notifications/inbox", { action: "clear" }],
    ]);
    // The 10 unread not yet loaded went too.
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });

  it("clears nothing when you cancel", async () => {
    const fetchMock = mockInbox({
      "": { data: many("n", 3), nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: "Clear all…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Clear all…" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(calls(fetchMock, "POST")).toEqual([]);
  });

  it("keeps the list, and says so, when clearing is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) =>
        init?.method === "DELETE" || init?.method === "POST"
          ? { ok: false, status: 500, json: async () => ({}) }
          : {
              ok: true,
              json: async () => ({
                data: [notif("a", true)],
                nextCursor: null,
                counts: { unread: 0 },
              }),
            },
      ),
    );
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(
      await screen.findByRole("button", { name: 'Clear "Title a"' }),
    );
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        expect.anything(),
        "Couldn't clear that notification.",
      ),
    );
    expect(screen.getByText("Title a")).toBeInTheDocument();
  });
});

describe("NotificationDropdown stays in step with the Inbox page", () => {
  const gets = (fetchMock: ReturnType<typeof mockInbox>) =>
    fetchMock.mock.calls.filter(([, init]) => !init?.method).length;

  it("reloads when the Inbox page changes notifications", async () => {
    const fetchMock = mockInbox({
      "": { data: [notif("a", false)], nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await screen.findByRole("button", { name: "Notifications, 1 unread" });
    // The Inbox page cleared everything.
    mockInbox({ "": { data: [], nextCursor: null } });
    act(() => announceNotificationsChanged("inbox"));
    expect(
      await screen.findByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(gets(fetchMock)).toBe(1);
  });

  it("tells the Inbox page about its own writes, without reloading itself", async () => {
    const heard = vi.fn();
    const off = onNotificationsChanged("inbox", heard);
    const fetchMock = mockInbox({
      "": { data: [notif("a", false)], nextCursor: null },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(
      await screen.findByRole("button", { name: 'Mark "Title a" read' }),
    );
    await screen.findByRole("button", { name: "Notifications" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(gets(fetchMock)).toBe(1);
    off();
  });
});

describe("NotificationDropdown preview", () => {
  it("previews a row on hover, with the whole message", async () => {
    const long = {
      ...notif("a", false),
      body: "The whole message, longer than two lines would ever show in the bell panel.",
    };
    mockInbox({ "": { data: [long], nextCursor: null } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NotificationDropdown orgId={ORG_ID} />
      </QueryClientProvider>,
    );
    await openBell();
    const row = (await screen.findByRole("menuitem", { name: /Title a/ }))
      .parentElement!;
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    fireEvent.mouseEnter(row);
    const popup = await screen.findByTestId(
      "notification-preview",
      {},
      { timeout: 2000 },
    );
    expect(popup).toHaveTextContent(long.body);
  });
});

describe("NotificationDropdown filter by kind", () => {
  const of = (id: string, type: string, read = true) => ({
    ...notif(id, read),
    type,
  });
  const byType = [
    { type: "comment.mentioned", count: 2 },
    { type: "work_item.assigned", count: 1 },
  ];

  it("offers the kinds with their counts, and lists only the one picked", async () => {
    const fetchMock = mockInbox({
      "": {
        data: [
          of("m1", "comment.mentioned"),
          of("a1", "work_item.assigned"),
          of("m2", "comment.mentioned"),
        ],
        nextCursor: null,
        byType,
      },
      "work_item.assigned:": {
        data: [of("a1", "work_item.assigned")],
        nextCursor: null,
        byType,
      },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    const group = await screen.findByRole("group", { name: "Show" });
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(group).getByRole("button", { name: /^Work item assigned\s*1$/ }));
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")).toHaveLength(1),
    );
    expect(screen.getByText("Title a1")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([u]) =>
        String(u).includes("type=work_item.assigned"),
      ),
    ).toBe(true);
    // And back.
    fireEvent.click(within(group).getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")).toHaveLength(3),
    );
  });

  it("keeps the kind when loading older", async () => {
    const fetchMock = mockInbox({
      "": {
        data: [of("m1", "comment.mentioned"), of("a1", "work_item.assigned")],
        nextCursor: "c0",
        byType,
      },
      "comment.mentioned:": {
        data: [of("m1", "comment.mentioned")],
        nextCursor: "c1",
        byType,
      },
      "comment.mentioned:c1": {
        data: [of("m2", "comment.mentioned")],
        nextCursor: null,
        byType,
      },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: /^Comment mentioned\s*2$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Title m2")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([u]) =>
          String(u).includes("type=comment.mentioned") &&
          String(u).includes("cursor=c1"),
      ),
    ).toBe(true);
  });

  it("still counts a new notification of another kind on the badge", async () => {
    mockInbox({
      "": {
        data: [of("m1", "comment.mentioned"), of("a1", "work_item.assigned")],
        nextCursor: null,
        byType,
      },
      "comment.mentioned:": {
        data: [of("m1", "comment.mentioned")],
        nextCursor: null,
        byType,
      },
    });
    render(<NotificationDropdown orgId={ORG_ID} />);
    await openBell();
    fireEvent.click(await screen.findByRole("button", { name: /^Comment mentioned\s*2$/ }));
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")).toHaveLength(1),
    );
    act(() => sse.emit!(of("a9", "work_item.assigned", false)));
    expect(
      await screen.findByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Title a9")).toBeNull();
  });
});
