// @vitest-environment jsdom
// COSMOS-156, second pass. The first one hung the axis extension entirely off
// the scroller's `scroll` event — which a browser fires only when the offset
// actually CHANGES. A freshly loaded Gantt sits at scrollLeft 0, so pushing
// further left is an overscroll: the wheel spins, the position is already 0,
// and no scroll event is ever dispatched. Verified on a running build: 50 wheel
// events produced 0 scroll events and the axis never moved off its first day.
// The past was reachable only by first scrolling RIGHT to get off the wall.
//
// Two things close that, and both are asserted here:
//   1. a wheel pushing INTO a wall extends the axis on the wheel event itself,
//      because there is no scroll event coming;
//   2. the view doesn't park on the left wall to begin with — once the scroller
//      can be measured it seeds a chunk of past and steps off 0, so ordinary
//      scrolling (scrollbar, keyboard, touch) reaches it without a gesture-
//      specific code path.
//
// jsdom has no layout, so the scroller's geometry is defined onto the element;
// what's asserted is the axis the component then DRAWS.
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

describe("TimelineView — the left wall (COSMOS-156)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("extends the past from the WHEEL when parked at scrollLeft 0, with no scroll event", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    expect(monthsOnAxis()).toEqual(["Jan 2026", "Feb 2026"]);

    const scroll = screen.getByTestId("gantt-scroll");
    // The reported state exactly: a freshly loaded board, already at the wall.
    measure(scroll, { scrollLeft: 0, scrollWidth: 5000, clientWidth: 800 });
    // If anything here dispatched a scroll event, this test would be proving the
    // OLD path still works rather than the new one. Nothing may.
    const scrolls = vi.fn();
    scroll.addEventListener("scroll", scrolls);

    fireEvent.wheel(scroll, { deltaX: -120, deltaY: 0 });

    await waitFor(() => expect(monthsOnAxis()).toContain("Oct 2025"));
    expect(monthsOnAxis()[0]).toBe("Oct 2025");
    expect(scrolls).not.toHaveBeenCalled();
    // And it stepped off the wall, so the ordinary scroll path takes over from here.
    expect(scroll.scrollLeft).toBe(90 * 28);
  });

  it("keeps extending on each further wheel into the wall", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollLeft: 0, scrollWidth: 5000, clientWidth: 800 });

    for (let i = 0; i < 3; i++) {
      // Back on the wall each time — the browser clamps an overscroll to 0.
      measure(scroll, { scrollLeft: 0 });
      fireEvent.wheel(scroll, { deltaX: -120, deltaY: 0 });
      await waitFor(() => expect(scroll.scrollLeft).toBeGreaterThan(0));
    }

    await waitFor(() => expect(monthsOnAxis()[0]).toBe("Apr 2025"));
  });

  it("treats shift+wheel as the horizontal gesture it is", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollLeft: 0, scrollWidth: 5000, clientWidth: 800 });

    // Chrome reports shift+wheel as deltaY and scrolls horizontally with it.
    fireEvent.wheel(scroll, { deltaX: 0, deltaY: -120, shiftKey: true });

    await waitFor(() => expect(monthsOnAxis()).toContain("Oct 2025"));
  });

  it("leaves the axis alone for a plain vertical wheel on the wall", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollLeft: 0, scrollWidth: 5000, clientWidth: 800 });

    // Scrolling DOWN a board that happens to sit at offset 0 is not a reach for
    // the past. Neither is ⌘/Ctrl+wheel, which is the zoom gesture.
    fireEvent.wheel(scroll, { deltaX: 0, deltaY: 240 });
    fireEvent.wheel(scroll, { deltaX: -120, deltaY: 0, ctrlKey: true });

    await waitFor(() => expect(monthsOnAxis()).toEqual(["Jan 2026", "Feb 2026"]));
    expect(scroll.scrollLeft).toBe(0);
  });

  it("does not park on the left wall once the scroller can be measured", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    const scroll = screen.getByTestId("gantt-scroll");
    measure(scroll, { scrollLeft: 0, scrollWidth: 5000, clientWidth: 800 });

    // A measurable layout pass (here: the window resize the view already
    // listens for) seeds a chunk of past and steps off 0, so reaching it needs
    // no wheel at all — a scrollbar drag or an arrow key gets there too.
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(scroll.scrollLeft).toBe(90 * 28));
    expect(monthsOnAxis()[0]).toBe("Oct 2025");
  });
});
