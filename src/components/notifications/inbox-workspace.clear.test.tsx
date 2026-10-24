// @vitest-environment jsdom
//
// COSMOS-216: clearing the whole inbox, or one kind of it. It deletes, so it
// asks first, names how many, and clears exactly what the view lists.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/inbox" }));

const PAGE = {
  data: [
    { id: "n1", type: "alerts.past_due", title: "FSC-7 is past due", body: "", url: null, read: false, createdAt: "2026-10-20T10:00:00.000Z" },
    { id: "n2", type: "work_item.mention", title: "You were mentioned", body: "", url: null, read: false, createdAt: "2026-10-19T10:00:00.000Z" },
  ],
  nextCursor: null,
  counts: {
    total: 40,
    unread: 12,
    byType: [
      { type: "alerts.past_due", count: 9 },
      { type: "work_item.mention", count: 3 },
    ],
  },
};
const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch }));

import { InboxWorkspace } from "./inbox-workspace";
import { announceNotificationsChanged, onNotificationsChanged } from "@/lib/notifications/changed";

const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ cleared: 12 }), { status: 200 }));

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

const clearCalls = () =>
  fetchSpy.mock.calls
    .map((c) => c as unknown as [string, RequestInit])
    .filter(([u, init]) => u.endsWith("/notifications/inbox") && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init.body)));

describe("InboxWorkspace — clearing the view", () => {
  it("asks first, names how many, and clears the unread view", async () => {
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Clear all…" }));
    const dialog = await screen.findByRole("dialog");
    // The inbox opens on unread: 12 of the 40.
    expect(within(dialog).getByText("Clear 12 notifications?")).toBeInTheDocument();
    expect(clearCalls()).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clearCalls()).toEqual([{ action: "clear", unreadOnly: true }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears only the picked kind", async () => {
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: /^Past due/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear Past due…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Clear 9 notifications?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(clearCalls()).toEqual([{ action: "clear", unreadOnly: true, type: "alerts.past_due" }]),
    );
  });

  it("counts the whole inbox once it shows everything", async () => {
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Showing unread" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear all…" }));
    expect(await screen.findByText("Clear 40 notifications?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clearCalls()).toEqual([{ action: "clear", unreadOnly: false }]));
  });

  it("clears nothing when you cancel", async () => {
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Clear all…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(clearCalls()).toEqual([]);
  });
});

describe("InboxWorkspace stays in step with the bell", () => {
  it("refetches when the bell changes notifications", async () => {
    renderInbox();
    await screen.findByRole("button", { name: "Clear all…" });
    const before = jsonFetch.mock.calls.length;
    announceNotificationsChanged("bell");
    await waitFor(() => expect(jsonFetch.mock.calls.length).toBeGreaterThan(before));
  });

  it("tells the bell when it clears", async () => {
    const heard = vi.fn();
    const off = onNotificationsChanged("bell", heard);
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Clear all…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    off();
  });
});

describe("InboxWorkspace preview", () => {
  it("previews a row on hover", async () => {
    renderInbox();
    const row = (await screen.findByText("FSC-7 is past due")).closest(".group") as HTMLElement;
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    fireEvent.mouseEnter(row);
    const popup = await screen.findByTestId("notification-preview", {}, { timeout: 2000 });
    expect(popup).toHaveTextContent("Past due");
  });
});
