// @vitest-environment jsdom
// Reproduces COSMOS-62: on the Release Timeline (Gantt), scrolling the chart
// left the ticket list behind — the timeline "wasn't associated with the
// tickets". Root cause: the labels and the chart lived in two SEPARATE scroll
// containers kept in sync by mirroring scrollTop in JS. The chart pane is taller
// (and its viewport is shortened by the horizontal scrollbar), so it could
// scroll while the label pane had nothing to scroll — the tickets didn't move.
//
// The fix puts both panes inside ONE scroll container as direct children, so
// vertical scroll is structurally locked. jsdom has no layout, so we can't
// measure scroll offsets; instead we assert the invariant that makes the desync
// impossible: a single scroll container, both panes as its direct children, and
// no independently-scrollable label column.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

// Portal/observer-heavy children aren't relevant to the scroll structure.
vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => null,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));
// Use the REAL filter-bar module (so `matchesCustomFieldFilters`, `bareTypeKey`,
// and `emptyFilters` are the genuine implementations the component ships with),
// overriding only the heavy `FilterBar` component — it never renders here.
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

const item = (n: number, start: string, due: string) => ({
  id: `i${n}`,
  ticketNumber: 100 + n,
  title: `Item ${n}`,
  createdAt: start,
  startDate: start,
  dueDate: due,
  columnKey: "todo",
  workItemType: { key: "TASK", name: "Task" },
  priority: "MEDIUM",
  workCategory: "BUSINESS",
  parentId: null,
  children: [],
  assigneeId: null,
  assignees: [],
  baselineStart: null,
  baselineEnd: null,
  storyPoints: null,
  completedAt: null,
});

const ITEMS = [
  item(1, "2026-01-05", "2026-01-20"),
  item(2, "2026-01-10", "2026-02-01"),
  item(3, "2026-01-15", "2026-01-25"),
];

// A minimal parent→child hierarchy (an epic with one story) so a collapse
// chevron actually renders — the flat ITEMS above have no parents, so no row is
// collapsible.
const HIER_ITEMS = [
  {
    ...item(1, "2026-01-05", "2026-01-20"),
    id: "epic1",
    ticketNumber: 1,
    title: "Epic One",
    workItemType: { key: "EPIC", name: "Epic" },
  },
  {
    ...item(2, "2026-01-06", "2026-01-18"),
    id: "story1",
    ticketNumber: 2,
    title: "Story One",
    parentId: "epic1",
  },
];

// Two past-due items: one still open (→ overdue) and one already completed (→
// NOT overdue, because it's done). Both dates stay in 2026 so the deterministic
// outcome doesn't depend on when the test runs, and the Gantt's date range
// stays small (COSMOS-104).
const OVERDUE_MIX = [
  item(1, "2026-01-05", "2026-01-20"),
  { ...item(2, "2026-01-10", "2026-01-25"), completedAt: "2026-01-24T00:00:00.000Z" },
];

// The work-items the fetcher mock serves; swapped per describe block so a test
// can opt into the hierarchy without changing the default flat dataset.
let activeItems: unknown[] = ITEMS;

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(activeItems);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve([]);
    if (url.endsWith("/cycles")) return Promise.resolve([]);
    if (url.includes("/boards/"))
      return Promise.resolve({
        id: "b1",
        columns: [
          { key: "todo", category: "TODO" },
          { key: "done", category: "DONE" },
        ],
      });
    return Promise.resolve([]);
  }),
}));

import { TimelineView, matchesFilters } from "./timeline-view";
import { emptyFilters, type BoardFilters } from "@/components/boards/shared/filter-bar";
import type { CustomField, WorkItem } from "@/types/models";

const renderTimeline = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

describe("TimelineView — labels and chart stay locked to one vertical scroll", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders both panes inside a single shared scroll container", async () => {
    renderTimeline();
    // Wait for the queries to settle and the Gantt to render.
    await screen.findByText("Work Items");
    // Sanity: a ticket label and the chart bars actually rendered, so there are
    // rows that could desync if the panes scrolled independently.
    expect(screen.getByText(/FSC-101/)).toBeInTheDocument();

    const scroll = screen.getByTestId("gantt-scroll");
    const left = screen.getByTestId("gantt-left");
    const chart = screen.getByTestId("gantt-chart");

    // Exactly one scroll container in the timeline body.
    expect(screen.getAllByTestId("gantt-scroll")).toHaveLength(1);

    // Both panes are DIRECT children of that one container, so a single vertical
    // scroll moves the labels and the bars together — they cannot diverge.
    expect(left.parentElement).toBe(scroll);
    expect(chart.parentElement).toBe(scroll);

    // The shared container is the scroller...
    expect(scroll.className).toMatch(/\boverflow-auto\b/);
    // ...and the label column is NOT its own scroller (the exact property whose
    // presence caused the reported desync).
    expect(left.className).not.toMatch(/overflow-(y-)?(auto|scroll)/);

    // The chart's bars are present in the shared container.
    expect(chart.querySelector("svg")).toBeInTheDocument();
  });
});

// COSMOS-68: the date header must stay pinned to the top of the timeline while
// scrolling DOWN the chart (so the dates are always readable). The header is
// `sticky top-0`, but that only works because the shared flex scroll container
// uses `items-start`: with the default `align-items: stretch`, each pane is
// stretched to the scroller's viewport height, collapsing the sticky containing
// block so the header slides away after the first viewport of scroll (verified
// in a real browser — jsdom has no layout, so we assert the structural
// invariants that make the pin work instead of measuring offsets).
describe("TimelineView — date header stays pinned while scrolling down (COSMOS-68)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps both headers `sticky top-0` inside an `items-start` scroll container", async () => {
    renderTimeline();
    await screen.findByText("Work Items");

    const scroll = screen.getByTestId("gantt-scroll");
    // The fix: without `items-start`, `align-items: stretch` collapses the
    // sticky containing block and the pinned header scrolls away. This is the
    // exact class whose absence reproduced the reported bug.
    expect(scroll.className).toMatch(/\bitems-start\b/);

    // The date header pins to the top on vertical scroll...
    const dateHeader = screen.getByTestId("gantt-date-header");
    expect(dateHeader.className).toMatch(/\bsticky\b/);
    expect(dateHeader.className).toMatch(/\btop-0\b/);
    // ...and sits inside the (horizontally-scrolling) chart column, so it stays
    // aligned with the day columns it labels during horizontal scroll.
    expect(screen.getByTestId("gantt-chart").contains(dateHeader)).toBe(true);
    // Layered above the scrolling chart body (z-index) so bars can't show through.
    expect(dateHeader.className).toMatch(/\bz-10\b/);

    // The left "Work Items" header pins on vertical scroll too, so the label
    // column keeps its heading while you scroll down.
    const leftHeader = screen.getByText("Work Items");
    expect(leftHeader.className).toMatch(/\bsticky\b/);
    expect(leftHeader.className).toMatch(/\btop-0\b/);
  });
});

// The Gantt/timeline must honor admin-defined custom fields in its filter, the
// same way the Kanban board does — otherwise "filter by a custom field like you
// filter by sprint" silently didn't work on this view (COSMOS-40).
describe("TimelineView.matchesFilters — custom-field filtering", () => {
  const def = (
    key: string,
    fieldType: CustomField["fieldType"],
    options: string[] = [],
  ): CustomField => ({
    id: `cf-${key}`,
    orgId: "o1",
    projectId: null,
    name: key,
    key,
    fieldType,
    options,
    required: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const cfItem = (customFields: Record<string, unknown>): WorkItem =>
    ({
      id: "i1",
      ticketNumber: 1,
      title: "Item",
      workItemType: { key: "TASK", name: "Task" },
      priority: "MEDIUM",
      assigneeId: null,
      assignees: [],
      cycleId: null,
      customFields,
    }) as unknown as WorkItem;

  const withCustom = (customFields: BoardFilters["customFields"]): BoardFilters => ({
    ...emptyFilters,
    customFields,
  });

  it("is inert when no custom-field constraint is active", () => {
    const item = cfItem({ goal: "Ship" });
    const defs = [def("goal", "SELECT", ["Ship"])];
    // emptyFilters has customFields: {} → the custom-field check must pass through.
    expect(matchesFilters(item, emptyFilters, defs)).toBe(true);
  });

  it("keeps only items whose SELECT value matches the active constraint", () => {
    const defs = [def("goal", "SELECT", ["Growth", "Retention"])];
    const filter = withCustom({ goal: "Growth" });
    expect(matchesFilters(cfItem({ goal: "Growth" }), filter, defs)).toBe(true);
    expect(matchesFilters(cfItem({ goal: "Retention" }), filter, defs)).toBe(false);
    expect(matchesFilters(cfItem({}), filter, defs)).toBe(false);
  });

  it("matches a MULTI_SELECT when the stored array contains the chosen option", () => {
    const defs = [def("teams", "MULTI_SELECT", ["A", "B", "C"])];
    const filter = withCustom({ teams: "B" });
    expect(matchesFilters(cfItem({ teams: ["A", "B"] }), filter, defs)).toBe(true);
    expect(matchesFilters(cfItem({ teams: ["A", "C"] }), filter, defs)).toBe(false);
  });

  it("treats a CHECKBOX constraint as 'only checked items'", () => {
    const defs = [def("blocked", "CHECKBOX")];
    const filter = withCustom({ blocked: "true" });
    expect(matchesFilters(cfItem({ blocked: true }), filter, defs)).toBe(true);
    expect(matchesFilters(cfItem({ blocked: false }), filter, defs)).toBe(false);
    expect(matchesFilters(cfItem({}), filter, defs)).toBe(false);
  });

  it("does a case-insensitive contains match for TEXT fields", () => {
    const defs = [def("owner", "TEXT")];
    const filter = withCustom({ owner: "jane" });
    expect(matchesFilters(cfItem({ owner: "Jane Doe" }), filter, defs)).toBe(true);
    expect(matchesFilters(cfItem({ owner: "John" }), filter, defs)).toBe(false);
  });

  it("still applies the built-in filters alongside a custom-field constraint", () => {
    const defs = [def("goal", "SELECT", ["Growth"])];
    const filter: BoardFilters = { ...withCustom({ goal: "Growth" }), priorities: ["HIGH"] };
    // Custom field matches but priority doesn't → excluded.
    expect(matchesFilters(cfItem({ goal: "Growth" }), filter, defs)).toBe(false);
  });
});

// COSMOS-69: collapsing a parent must survive leaving the timeline and coming
// back within the session. The collapse state is persisted to sessionStorage
// keyed by board, so a fresh mount restores it rather than starting expanded.
describe("TimelineView — collapse state persists across navigation (COSMOS-69)", () => {
  beforeEach(() => {
    activeItems = HIER_ITEMS;
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.sessionStorage.clear();
    activeItems = ITEMS;
  });

  it("keeps a collapsed epic collapsed after the view is remounted", async () => {
    const first = renderTimeline();
    await screen.findByText("Work Items");
    // While expanded, the epic's child story is on screen.
    expect(screen.getByText(/FSC-2/)).toBeInTheDocument();

    // Collapse the epic — its whole subtree (the story) disappears.
    fireEvent.click(screen.getByLabelText("Collapse children"));
    expect(screen.queryByText(/FSC-2/)).not.toBeInTheDocument();

    // Navigate away and back: fully unmount, then mount a brand-new instance.
    first.unmount();
    renderTimeline();
    await screen.findByText("Work Items");

    // The collapse survived the remount — the child is still hidden and the epic
    // now offers to expand (proof the restored state, not a fresh default).
    expect(screen.queryByText(/FSC-2/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Expand children")).toBeInTheDocument();
  });
});

// COSMOS-104: leaders need to see items that blew past their planned end date
// without completing. The Gantt gains an "Overdue" lens that narrows the chart
// to exactly those items — past due AND not in a done/cancelled column.
describe("TimelineView — Overdue lens surfaces late items (COSMOS-104)", () => {
  beforeEach(() => {
    activeItems = OVERDUE_MIX;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    activeItems = ITEMS;
  });

  it("filters the chart to only past-due, not-done items when toggled on", async () => {
    renderTimeline();
    await screen.findByText("Work Items");

    // Both items show by default (no filter active).
    expect(screen.getByText(/FSC-101/)).toBeInTheDocument();
    expect(screen.getByText(/FSC-102/)).toBeInTheDocument();

    // Flip the Overdue lens: only the past-due, still-open item (101) remains;
    // the past-due but already-completed item (102) drops out.
    fireEvent.click(screen.getByRole("button", { name: /Overdue/ }));
    expect(screen.getByText(/FSC-101/)).toBeInTheDocument();
    expect(screen.queryByText(/FSC-102/)).not.toBeInTheDocument();
  });

  it("counts the overdue items on the lens toggle", async () => {
    renderTimeline();
    await screen.findByText("Work Items");
    // Exactly one of the two seeded items is overdue.
    expect(screen.getByRole("button", { name: /Overdue \(1\)/ })).toBeInTheDocument();
  });
});
