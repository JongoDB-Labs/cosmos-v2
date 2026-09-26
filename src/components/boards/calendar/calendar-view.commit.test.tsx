// @vitest-environment jsdom
//
// COSMOS-150 — the Calendar board's Commit control.
//
// The planning calendar showed every dated item identically and offered no way
// to act on one, so a tentative event (dated, but owned by no interval) was
// indistinguishable from work a Program Increment had already absorbed, and
// moving it onto the PI board meant leaving the calendar for the Issues list.
//
// This locks the three things that make the control trustworthy:
//   1. Commit is offered ONLY for a tentative event, and only when a PI covers
//      its day — a committed row shows where it went instead.
//   2. Pressing it PUTs `intervalId` to the covering PI through the ordinary
//      work-item route (which is what writes the activity trail and publishes
//      the org SSE other boards listen on), and changes nothing else — no
//      dates moved, no planning or AAR items invented. That last part is the
//      decision recorded on the ticket, so it is asserted, not assumed.
//   3. "Tentative only" narrows the month to the pencilled-in work.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

// Heavy trees this spec doesn't exercise.
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => <button type="button">New issue</button>,
}));
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: () => null,
}));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/boards/shared/filter-bar")>()),
  FilterBar: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

// A planner, not a viewer — Commit writes, so it is gated on ITEM_UPDATE.
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => true,
    }),
  };
});

// One PI covering March 2026; a sprint inside it, to prove commit targets the PI.
const INTERVALS = [
  {
    id: "sp1",
    name: "Sprint 12",
    intervalKind: "SPRINT",
    startDate: "2026-03-09T00:00:00.000Z",
    endDate: "2026-03-20T00:00:00.000Z",
  },
  {
    id: "pi1",
    name: "PI-001",
    intervalKind: "PROGRAM_INCREMENT",
    startDate: "2026-03-01T00:00:00.000Z",
    endDate: "2026-03-31T00:00:00.000Z",
  },
];

const item = (over: Record<string, unknown>) => ({
  id: String(over.id),
  ticketNumber: Number(over.ticketNumber ?? 1),
  title: String(over.title ?? "Item"),
  columnKey: "todo",
  priority: "MEDIUM",
  assigneeId: null,
  intervalId: null,
  startDate: null,
  dueDate: "2026-03-10T12:00:00.000Z",
  highlight: null,
  tags: [],
  customFields: {},
  ...over,
});

const ITEMS = [
  item({ id: "w1", ticketNumber: 1, title: "Kickoff workshop" }),
  item({ id: "w2", ticketNumber: 2, title: "Already planned", intervalId: "pi1" }),
  // Outside every PI: the control must say so rather than disappear.
  item({ id: "w3", ticketNumber: 3, title: "Far future review", dueDate: "2026-03-05T12:00:00.000Z" }),
];

const jsonFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch }));

import { CalendarView } from "./calendar-view";

const renderCalendar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CalendarView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

/** Open the day cell holding `n` items by clicking its "N items" affordance. */
const openDay = async (n: number) => {
  const opener = await screen.findByRole("button", { name: `${n} item${n === 1 ? "" : "s"}` });
  fireEvent.click(opener);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Pin the month so the default view is the one the fixtures are dated in.
  vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
  jsonFetch.mockReset();
  jsonFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve({ id: "w1" });
    if (url.endsWith("/intervals")) return Promise.resolve(INTERVALS);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe("CalendarView — committing a tentative event to the PI board", () => {
  it("offers Commit for the tentative event and shows where the committed one went", async () => {
    renderCalendar();
    await openDay(2);

    // The committed row names its PI instead of offering the button again.
    expect(await screen.findByText("Committed · PI-001")).toBeInTheDocument();

    // Exactly one Commit button on this day — for "Kickoff workshop".
    const buttons = screen.getAllByRole("button", { name: "Commit" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("title", "Commit to PI-001");
    expect(buttons[0]).not.toBeDisabled();
  });

  it("PUTs the covering Program Increment — and nothing else — when pressed", async () => {
    renderCalendar();
    await openDay(2);

    fireEvent.click(await screen.findByRole("button", { name: "Commit" }));

    await waitFor(() => {
      expect(
        jsonFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT"),
      ).toBe(true);
    });

    const writes = jsonFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method,
    );
    // One write, not a cascade of auto-created planning/AAR work items.
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/orgs/o1/projects/p1/work-items/w1");
    expect(init.method).toBe("PUT");
    // The PI, not the sprint that also covers the day; dates untouched.
    expect(JSON.parse(String(init.body))).toEqual({ intervalId: "pi1" });
  });

  it("disables Commit, with a reason, when no Program Increment covers the day", async () => {
    jsonFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) return Promise.resolve({ id: "w3" });
      if (url.endsWith("/intervals")) return Promise.resolve([INTERVALS[0]]); // sprint only
      if (url.endsWith("/work-items")) return Promise.resolve([ITEMS[2]]);
      if (url.endsWith("/members")) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    await openDay(1);

    const btn = await screen.findByRole("button", { name: "Commit" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "No Program Increment covers 2026-03-05");
  });

  it("narrows the month to tentative events when 'Tentative only' is pressed", async () => {
    renderCalendar();
    await screen.findByTitle(/FSC-2: Already planned/);

    const toggle = screen.getByRole("button", { name: "Tentative only" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTitle(/FSC-2: Already planned/)).toBeNull();
    // The pencilled-in ones stay, and say so.
    expect(screen.getByTitle("FSC-1: Kickoff workshop · Tentative")).toBeInTheDocument();
    expect(screen.getByTitle("FSC-3: Far future review · Tentative")).toBeInTheDocument();
  });
});
