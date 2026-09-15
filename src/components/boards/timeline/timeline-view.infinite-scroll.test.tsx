// @vitest-environment jsdom
// COSMOS-156: "scroll left infinitely and right infinitely to see everything
// they want". The Gantt's axis used to be a FIXED window — the union of the
// visible items' painted spans plus 3 days before and 7 after — so scrolling
// stopped dead at those edges and the calendar around a plan was unreachable.
//
// Assumption this was built on (open question, deliberately not waited on): the
// axis extends on demand, a quarter at a time, with no clamp to the data range —
// rather than simply being padded out to a wider fixed buffer.
//
// jsdom has no layout, so the scroller's geometry is defined onto the element
// and scroll events are fired by hand; what's asserted is the axis the component
// then DRAWS (its month labels), which is the thing the user is scrolling to see.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => null,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

// One item, mid-January 2026. With the data window's own padding the axis spans
// 2026-01-02 → 2026-02-08: two months, and nothing outside them.
const ITEMS = [
  {
    id: "i1",
    ticketNumber: 101,
    title: "Item 1",
    createdAt: "2026-01-05",
    startDate: "2026-01-05",
    dueDate: "2026-02-01",
    columnKey: "todo",
    workItemType: { key: "TASK", name: "Task" },
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children: [],
    assigneeId: null,
    assignees: [],
    actualStart: null,
    storyPoints: null,
    completedAt: null,
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.includes("/boards/"))
      return Promise.resolve({ id: "b1", columns: [{ key: "todo", category: "TODO" }] });
    return Promise.resolve([]);
  }),
}));

import { TimelineView } from "./timeline-view";

const renderTimeline = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

/** Give the (layout-less) scroller a geometry the component can read. */
function measure(
  el: HTMLElement,
  geom: Partial<
    Record<"scrollLeft" | "scrollTop" | "scrollWidth" | "clientWidth", number>
  >,
) {
  for (const [k, v] of Object.entries(geom)) {
    Object.defineProperty(el, k, { value: v, writable: true, configurable: true });
  }
}

/** Month labels currently on the date header, e.g. "Jan 2026". */
function monthsOnAxis(): string[] {
  return [...screen.getByTestId("gantt-date-header").querySelectorAll("text")]
    .map((t) => t.textContent ?? "")
    .filter((s) => /^[A-Z][a-z]{2} \d{4}$/.test(s));
}

describe("TimelineView — the time axis extends as you scroll (COSMOS-156)", () => {
  beforeEach(() => {
    // The data window always contains TODAY as well as the items, so the axis
    // these tests start from is only fixed if "now" is. Date alone is faked, so
    // React's scheduler and `waitFor` keep their real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("reveals earlier months when you scroll into the left edge", async () => {
    renderTimeline();
    await screen.findByText("Work Items");

    // The axis starts clamped to the item's own dates.
    expect(monthsOnAxis()).toEqual(["Jan 2026", "Feb 2026"]);

    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollWidth: 5000, clientWidth: 800, scrollLeft: 900 });
    fireEvent.scroll(scroll); // settle the last-known offset mid-chart

    // Now travel LEFT into the edge.
    measure(scroll, { scrollLeft: 4 });
    fireEvent.scroll(scroll);

    // A quarter of calendar before the plan is now on the axis.
    await waitFor(() => expect(monthsOnAxis()).toContain("Oct 2025"));
    expect(monthsOnAxis()[0]).toBe("Oct 2025");

    // ...and the viewport was pushed back over what it was looking at, so the
    // chart didn't jump sideways under the cursor. 90 days at 28px/day.
    expect(scroll.scrollLeft).toBe(4 + 90 * 28);
  });

  it("keeps going — each reach for an edge buys another quarter", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollWidth: 5000, clientWidth: 800, scrollLeft: 900 });
    fireEvent.scroll(scroll);

    for (let i = 0; i < 3; i++) {
      measure(scroll, { scrollLeft: 4 });
      fireEvent.scroll(scroll);
      // Each extension has to land (and give the viewport back) before the next
      // reach counts — one flick must not queue a year.
      await waitFor(() => expect(scroll.scrollLeft).toBeGreaterThan(4));
      measure(scroll, { scrollLeft: 900 });
      fireEvent.scroll(scroll);
    }

    // Three quarters back from 2026-01-02 lands in April 2025.
    await waitFor(() => expect(monthsOnAxis()[0]).toBe("Apr 2025"));
  });

  it("reveals later months when you scroll into the right edge", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    expect(monthsOnAxis()).toEqual(["Jan 2026", "Feb 2026"]);

    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollWidth: 5000, clientWidth: 800, scrollLeft: 1000 });
    fireEvent.scroll(scroll);
    // Max offset is scrollWidth - clientWidth = 4200; land on it.
    measure(scroll, { scrollLeft: 4200 });
    fireEvent.scroll(scroll);

    await waitFor(() => expect(monthsOnAxis()).toContain("May 2026"));
    // Nothing was prepended, so the left edge of the axis is untouched.
    expect(monthsOnAxis()[0]).toBe("Jan 2026");
  });

  it("does not invent calendar when the scroll was purely vertical", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    const scroll = screen.getByTestId("gantt-scroll");
    // A board sitting at offset 0 is at BOTH edges by position. Scrolling down
    // moves scrollTop only — the axis must not grow in either direction.
    measure(scroll, { scrollWidth: 800, clientWidth: 800, scrollLeft: 0, scrollTop: 0 });
    fireEvent.scroll(scroll);
    measure(scroll, { scrollTop: 400 });
    fireEvent.scroll(scroll);

    await waitFor(() => expect(monthsOnAxis()).toEqual(["Jan 2026", "Feb 2026"]));
  });
});
