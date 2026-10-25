// @vitest-environment jsdom
//
// The Subscribe dialog: the schedule the user picks is the cron that's sent,
// in their time zone; a bad custom cron says why and sends nothing; existing
// subscriptions can be paused and removed.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/issues", useParams: () => ({ orgSlug: "acme" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { SubscribeDialog } from "./subscribe-dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";
import type { SavedFilter } from "./use-saved-filters";

const FILTER = { id: "f1", name: "Urgent" } as SavedFilter;
const BASE = "/api/v1/orgs/o1/saved-views/f1/subscriptions";
const EXISTING = {
  id: "s1", createdById: "u1", cron: "0 8 * * 1-5", timezone: "UTC", format: "LIST", sendWhenEmpty: false, onlyChanges: false,
  nextRunAt: "2026-10-26T08:00:00Z", disabledAt: null, disabledReason: null, lastError: null,
  recipientUser: { id: "u1", displayName: "Ada" }, recipientTeam: null,
};

function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SubscribeDialog orgId="o1" filter={FILTER} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}
const posted = () => vi.mocked(jsonFetch).mock.calls.filter(([u, i]) => u === BASE && (i as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation((async (url: string, init?: RequestInit) => {
    if (url === BASE && !init?.method) return { subscriptions: [EXISTING], teams: [{ id: "t1", name: "Platform" }] };
    return {};
  }) as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubscribeDialog", () => {
  it("subscribes me on weekdays at 08:00 in my zone by default", async () => {
    open();
    await screen.findByText(/Weekdays at 08:00/);
    expect(screen.getAllByText(/^Next: .*\(/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    const body = JSON.parse(String((posted()[0][1] as RequestInit).body));
    expect(body).toEqual({
      recipient: { kind: "me" },
      cron: "0 8 * * 1-5",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      format: "LIST",
      onlyChanges: false,
      sendWhenEmpty: false,
    });
  });

  it("the time and options picked are what's sent", async () => {
    open();
    await screen.findByText(/Weekdays at 08:00/);
    fireEvent.change(screen.getByLabelText("At"), { target: { value: "17:30" } });
    fireEvent.click(screen.getByLabelText("Only items that are new since the last email"));
    fireEvent.click(screen.getByLabelText("Send even when nothing matches"));
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(JSON.parse(String((posted()[0][1] as RequestInit).body))).toMatchObject({ cron: "30 17 * * 1-5", onlyChanges: true, sendWhenEmpty: true });
  });

  it("a bad custom cron says why and sends nothing", async () => {
    open();
    await screen.findByText(/Weekdays at 08:00/);
    fireEvent.click(screen.getByRole("combobox", { name: "When" }));
    fireEvent.click(await screen.findByRole("option", { name: "Custom (cron)" }));
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "* * * * *" } });
    expect(screen.getAllByText(/once an hour/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(posted()).toHaveLength(0);
  });

  it("lists subscriptions to pause and remove", async () => {
    open();
    const list = await screen.findByRole("list", { name: "Subscriptions" });
    fireEvent.click(within(list).getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(`${BASE}/s1`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    );
    fireEvent.click(within(list).getByRole("button", { name: "Remove subscription for Ada" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith(`${BASE}/s1`, { method: "DELETE" }));
  });
});
