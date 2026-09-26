// @vitest-environment jsdom
//
// COSMOS-150 follow-up — the calendar grid and the Commit button must agree
// about which day an event is on.
//
// Found by driving the running app in America/New_York. The grid bucketed items
// by LOCAL date parts (`new Date(iso)` then `getMonth()`/`getDate()`), while the
// Commit decision reads the `YYYY-MM-DD` prefix — the rule
// `src/lib/time/date-only.ts` exists to document. For any date stored at UTC
// midnight (seeds and imports write those; only the app's own date pickers use
// midday) the two disagree anywhere west of UTC, and the screen contradicted
// itself in two visible ways:
//
//   1. An event due 2026-09-21 was drawn in the Sep 20 cell, so a panel headed
//      "Sunday, September 20" carried a disabled Commit reading "No Program
//      Increment covers 2026-09-21" — a date the panel never mentions, and one
//      that falls outside the PI the header's own day sits inside.
//   2. An event due 2026-09-01 fell out of September altogether, drawn on Aug 31
//      and therefore committable only by navigating back a month.
//
// Both are the same defect: two answers to "which calendar day is this". The
// grid now buckets through `eventDay`, the same function the Commit control
// reads, so there is one answer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Before the module graph loads: Node applies a `process.env.TZ` assignment to
// every subsequent Date operation, and `vi.hoisted` is the only hook that runs
// ahead of the (hoisted) imports above.
vi.hoisted(() => {
  process.env.TZ = "America/New_York";
});

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

// The PI the verifier drove: Sep 1 – Sep 20, stored at UTC midnight like a seed
// or an import writes it.
const PI = {
  id: "pi3",
  name: "PI-2026.3",
  intervalKind: "PROGRAM_INCREMENT",
  startDate: "2026-09-01T00:00:00.000Z",
  endDate: "2026-09-20T00:00:00.000Z",
};

const item = (over: Record<string, unknown>) => ({
  id: String(over.id),
  ticketNumber: Number(over.ticketNumber ?? 1),
  title: String(over.title ?? "Item"),
  columnKey: "todo",
  priority: "MEDIUM",
  assigneeId: null,
  intervalId: null,
  startDate: null,
  dueDate: null,
  highlight: null,
  tags: [],
  customFields: {},
  ...over,
});

const ITEMS = [
  // One day past the PI's end — UTC midnight, so local parts say Sep 20.
  item({ id: "w1", ticketNumber: 1, title: "Day after the PI", dueDate: "2026-09-21T00:00:00.000Z" }),
  // The PI's first day — local parts say Aug 31, i.e. a different month.
  item({ id: "w2", ticketNumber: 2, title: "First day of the PI", dueDate: "2026-09-01T00:00:00.000Z" }),
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

/**
 * Open the day panel for the cell holding `title`, by clicking that cell's own
 * "1 item" affordance — not the first one on the grid, so the assertions cannot
 * drift onto a neighbouring day.
 */
const openDayHolding = async (title: string) => {
  const chip = await screen.findByTitle(title);
  // chip → the `space-y-0.5` list → the day cell.
  const cell = chip.parentElement?.parentElement;
  expect(cell).toBeTruthy();
  fireEvent.click(within(cell as HTMLElement).getByRole("button", { name: "1 item" }));
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
  jsonFetch.mockReset();
  jsonFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve({ id: "w1" });
    if (url.endsWith("/intervals")) return Promise.resolve([PI]);
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

describe("CalendarView — the drawn day and the committed day, west of UTC", () => {
  it("runs in a timezone behind UTC, which is what makes this fail", () => {
    // Guards the fixture itself: in UTC both readings agree and the spec is vacuous.
    expect(new Date("2026-09-21T00:00:00.000Z").getDate()).toBe(20);
  });

  it("keeps an event due on the 1st inside the month it belongs to", async () => {
    renderCalendar();
    // Was drawn on Aug 31 and so absent from the September grid entirely —
    // reachable, and committable, only by paging back a month.
    await screen.findByTitle("FSC-2: First day of the PI · Tentative");

    await openDayHolding("FSC-2: First day of the PI · Tentative");
    expect(screen.getByRole("heading", { name: "Tuesday, September 1" })).toBeInTheDocument();

    // And it is inside PI-2026.3, so Commit is live rather than disabled.
    const commit = screen.getByRole("button", { name: "Commit" });
    expect(commit).not.toBeDisabled();
    expect(commit).toHaveAttribute("title", "Commit to PI-2026.3");
  });

  it("reasons about the same day the panel is headed with", async () => {
    renderCalendar();
    await openDayHolding("FSC-1: Day after the PI · Tentative");

    // The panel used to be headed "Sunday, September 20" — a day squarely
    // inside PI-2026.3 — beside a button refusing a date it never showed.
    expect(screen.getByRole("heading", { name: "Monday, September 21" })).toBeInTheDocument();

    const commit = screen.getByRole("button", { name: "Commit" });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute("title", "No Program Increment covers 2026-09-21");
  });
});
