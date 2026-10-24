// @vitest-environment jsdom
//
// COSMOS-99: the inbox could only "Mark all read". One notification could not be
// marked read or unread, or cleared, although the per-notification PUT/DELETE
// endpoints existed. Using either must also never follow the row's link.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/inbox" }));

const PAGE = {
  data: [
    { id: "n1", type: "work_item.mention", title: "You were mentioned on FSC-7", body: "", url: "/issues?item=FSC-7", read: false, createdAt: "2026-10-20T10:00:00.000Z" },
    { id: "n2", type: "time.approved", title: "Your timesheet was approved", body: "", url: null, read: true, createdAt: "2026-10-19T10:00:00.000Z" },
  ],
  nextCursor: null,
  counts: { total: 2, unread: 1, byType: [] },
};
const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch }));

import { InboxWorkspace } from "./inbox-workspace";

const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));

beforeEach(() => {
  jsonFetch.mockReset().mockResolvedValue(PAGE);
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InboxWorkspace orgId="o1" />
    </QueryClientProvider>,
  );
}

describe("InboxWorkspace — one notification at a time", () => {
  it("marks an unread notification read, without following its link", async () => {
    renderInbox();
    const button = await screen.findByRole("button", { name: 'Mark "You were mentioned on FSC-7" read' });
    expect(button.closest("a")).toBeNull();

    fireEvent.click(button);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/notifications/n1",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ read: true }) }),
      ),
    );
    // The list refetches so the dot and counts follow.
    await waitFor(() => expect(jsonFetch.mock.calls.length).toBeGreaterThan(1));
  });

  it("marks a read notification unread", async () => {
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: 'Mark "Your timesheet was approved" unread' }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/notifications/n2",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ read: false }) }),
      ),
    );
  });

  it("clears a notification from the inbox", async () => {
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: 'Clear "You were mentioned on FSC-7"' }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/v1/orgs/o1/notifications/n1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("still links the notification itself to what it is about", async () => {
    renderInbox();
    const title = await screen.findByText("You were mentioned on FSC-7");

    expect(title.closest("a")?.getAttribute("href")).toBe("/acme/issues?item=FSC-7");
  });
});
