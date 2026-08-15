// @vitest-environment jsdom
// Plan-drift phantoms: proves the WIRING between lib/boards/plan-drift.ts (whose
// geometry is unit-tested there) and the SVG. The pure function being right does
// not mean the component paints it, in the right order, on the right bar.
//
// Reported: the red phantoms "don't reflect the slipped end dates very well".
// They could not — one ghost covered the WHOLE planned span in a single health
// colour, so a late item just went red end to end and never showed the slip.
//
// Original header of the file this harness came from — COSMOS-62: on the Release Timeline (Gantt), scrolling the chart
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
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

// The editing controls (Shift, undo/redo, the row checkboxes) are gated on
// ITEM_UPDATE, and `usePermissions` falls back to VIEWER outside a provider — so
// the default render has none of them. This flag is flipped per describe block,
// leaving every other test on the viewer default it was written against. It
// lives in `vi.hoisted` because the mock factory runs during the import phase,
// before a plain top-level `let` has been initialised.
const perms = vi.hoisted(() => ({ canEdit: false }));
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
      can: () => perms.canEdit,
    }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

// Portal/observer-heavy children aren't relevant to the scroll structure.
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => null,
}));
// Stubbed down to the one fact the tests care about — WHICH item the view asked
// to open — so "a bar click opens the ticket" is observable without dragging the
// real sheet's portals and observers into every render.
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: ({ item, open }: { item: { id: string } | null; open: boolean }) =>
    open && item ? <div data-testid="detail-sheet">{item.id}</div> : null,
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
  actualStart: null,
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
// A fixture whose API order is deliberately NOT its drawn order: roots are
// ordered by start date and a child is drawn under its parent, so the raw list
// (r3, r2, epic, child) renders as 301, 304, 302, 303. Ranging over the raw list
// instead of the drawn one would select rows the user never dragged across —
// this is what makes "the currently VISIBLE, ordered row list" testable.
// The work-items the fetcher mock serves; swapped per describe block so a test
// can opt into the hierarchy without changing the default flat dataset.
let activeItems: unknown[] = ITEMS;
// Real Milestone rows, as the milestones API returns them. Dated inside the
// window the ITEMS fixture spans so a marker has somewhere to land.
const activeMilestones: unknown[] = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(activeItems);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    if (url.endsWith("/milestones")) return Promise.resolve(activeMilestones);
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

import { TimelineView } from "./timeline-view";

const renderTimeline = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};


const DRIFT_ITEMS = [
  {
    // Planned 05->20 Jan, actually began 09 Jan and ran to 27 Jan: late start
    // AND a slipped end, so both phantoms must appear on one bar.
    ...item(1, "2026-01-05", "2026-01-20"),
    id: "late",
    ticketNumber: 901,
    actualStart: "2026-01-09",
    completedAt: "2026-01-27",
  },
  {
    // Began 4 days early, finished on plan: green only, no red.
    ...item(2, "2026-01-10", "2026-01-25"),
    id: "early",
    ticketNumber: 902,
    actualStart: "2026-01-06",
    completedAt: "2026-01-25",
  },
];

const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

async function renderWithPlanDrift() {
  activeItems = DRIFT_ITEMS;
  const utils = renderTimeline();
  await screen.findByText("Work Items");
  fireEvent.click(screen.getByRole("button", { name: /plan drift/i }));
  return utils;
}

describe("TimelineView — plan-drift phantoms", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  it("draws no phantoms until the lens is switched on", async () => {
    activeItems = DRIFT_ITEMS;
    renderTimeline();
    await screen.findByText("Work Items");
    expect(screen.queryByTestId("gantt-drift-amber-late")).toBeNull();
    expect(screen.queryByTestId("gantt-drift-red-late")).toBeNull();
  });

  it("a late start draws AMBER ending exactly where the solid bar begins", async () => {
    await renderWithPlanDrift();
    const amber = await screen.findByTestId("gantt-drift-amber-late");
    const bar = screen.getByTestId("gantt-bar-late");
    // The phantom's right edge IS the bar's left edge: it covers planned->actual
    // start and stops, so it reads as "this much late" without hiding the bar.
    expect(num(amber, "x") + num(amber, "width")).toBeCloseTo(num(bar, "x"), 1);
    expect(num(amber, "x")).toBeLessThan(num(bar, "x"));
  });

  it("an early start draws GREEN starting at the solid bar's left edge", async () => {
    await renderWithPlanDrift();
    const green = await screen.findByTestId("gantt-drift-green-early");
    const bar = screen.getByTestId("gantt-bar-early");
    // Same phantom flipped: it begins where the bar begins and extends RIGHT,
    // over the bar's head, to the planned start.
    expect(num(green, "x")).toBeCloseTo(num(bar, "x"), 1);
    expect(num(green, "width")).toBeGreaterThan(0);
  });

  it("a slipped end draws RED covering only planned end -> actual end", async () => {
    await renderWithPlanDrift();
    const red = await screen.findByTestId("gantt-drift-red-late");
    const bar = screen.getByTestId("gantt-bar-late");
    // The bug was red spanning the whole planned bar. It must START after the
    // bar does — the slip is at the END — and must not reach back to the origin.
    expect(num(red, "x")).toBeGreaterThan(num(bar, "x"));
    expect(num(red, "width")).toBeLessThan(num(bar, "width"));
  });

  it("red paints AFTER the solid bar, so a slip is never hidden under it", async () => {
    await renderWithPlanDrift();
    const red = screen.getByTestId("gantt-drift-red-late");
    const bar = screen.getByTestId("gantt-bar-late");
    // SVG has no z-index: later siblings paint on top. This is the ordering the
    // "red takes priority and overlays the blocks" rule depends on.
    expect(bar.compareDocumentPosition(red) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("GREEN paints after the bar — behind it, an early start is invisible", async () => {
    // Green covers the bar's HEAD by construction, so painting it first hid it
    // completely under a completed (green) bar at any opacity. Amber is the only
    // phantom that lands on empty canvas, so it is the only one drawn behind.
    await renderWithPlanDrift();
    const green = screen.getByTestId("gantt-drift-green-early");
    const bar = screen.getByTestId("gantt-bar-early");
    expect(bar.compareDocumentPosition(green) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("AMBER paints before the bar, so the bar keeps its own left edge", async () => {
    await renderWithPlanDrift();
    const amber = screen.getByTestId("gantt-drift-amber-late");
    const bar = screen.getByTestId("gantt-bar-late");
    expect(amber.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an item that finished on plan gets no red phantom", async () => {
    await renderWithPlanDrift();
    await screen.findByTestId("gantt-drift-green-early");
    expect(screen.queryByTestId("gantt-drift-red-early")).toBeNull();
  });
});
