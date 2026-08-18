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
// Dependency edges the Blocked lens reads. Swapped per describe block.
let activeLinks: unknown[] = [];
// Real Milestone rows, as the milestones API returns them. Dated inside the
// window the ITEMS fixture spans so a marker has somewhere to land.
const activeMilestones: unknown[] = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(activeItems);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve(activeLinks);
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


const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

const DRIFT_ITEMS = [
  {
    // Planned 05->20 Jan, actually ran 09->27 Jan: BEHIND at both ends — a red
    // shadow on the left, red stripes on the right.
    ...item(1, "2026-01-05", "2026-01-20"),
    id: "behind",
    ticketNumber: 901,
    actualStart: "2026-01-09",
    completedAt: "2026-01-27",
  },
  {
    // Planned 10->25 Jan, actually ran 06->21 Jan: AHEAD at both ends — green
    // stripes on the left, a green shadow on the right.
    ...item(2, "2026-01-10", "2026-01-25"),
    id: "ahead",
    ticketNumber: 902,
    actualStart: "2026-01-06",
    completedAt: "2026-01-21",
  },
  {
    // Finished late with NO recorded start — imported work, and tickets whose
    // actual_start was cleared in bulk. The slip is real and must still show.
    ...item(3, "2026-01-05", "2026-01-20"),
    id: "noStart",
    ticketNumber: 903,
    actualStart: null,
    completedAt: "2026-01-27",
  },
  {
    // NO actuals at all and long past due. The counterweight to `noStart`: the
    // end mark keys off a REAL end, so untouched work stays bare however overdue.
    ...item(4, "2026-01-05", "2026-01-20"),
    id: "untouched",
    ticketNumber: 904,
    actualStart: null,
    completedAt: null,
  },
];

async function renderWithPlanDrift() {
  activeItems = DRIFT_ITEMS;
  const utils = renderTimeline();
  await screen.findByText("Work Items");
  fireEvent.click(screen.getByRole("button", { name: /plan drift/i }));
  return utils;
}

// Colour answers ONE question — ahead of plan, or behind it. Style answers a
// second, independent one: does the mark lie over the bar, or on bare canvas?
// The old scheme put "started late" (amber) and "finished late" (red) on the
// same axis, so colour could not be read as ahead-vs-behind at all.
describe("TimelineView — drift colour is ahead-vs-behind", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  it("draws no marks until the lens is switched on", async () => {
    activeItems = DRIFT_ITEMS;
    renderTimeline();
    await screen.findByText("Work Items");
    expect(screen.queryByTestId("gantt-drift-red-start-behind")).toBeNull();
    expect(screen.queryByTestId("gantt-drift-red-end-behind")).toBeNull();
  });

  it("a late start is RED, and ends exactly where the solid bar begins", async () => {
    await renderWithPlanDrift();
    const red = await screen.findByTestId("gantt-drift-red-start-behind");
    const bar = screen.getByTestId("gantt-bar-behind");
    expect(num(red, "x") + num(red, "width")).toBeCloseTo(num(bar, "x"), 1);
    expect(num(red, "x")).toBeLessThan(num(bar, "x"));
  });

  it("an early start is GREEN, and begins at the solid bar's left edge", async () => {
    await renderWithPlanDrift();
    const green = await screen.findByTestId("gantt-drift-green-start-ahead");
    const bar = screen.getByTestId("gantt-bar-ahead");
    expect(num(green, "x")).toBeCloseTo(num(bar, "x"), 1);
    expect(num(green, "width")).toBeGreaterThan(0);
  });

  it("a late finish is RED, covering only planned end -> actual end", async () => {
    await renderWithPlanDrift();
    const red = await screen.findByTestId("gantt-drift-red-end-behind");
    const bar = screen.getByTestId("gantt-bar-behind");
    expect(num(red, "x")).toBeGreaterThan(num(bar, "x"));
    expect(num(red, "width")).toBeLessThan(num(bar, "width"));
  });

  it("an early finish is GREEN, and starts where the solid bar stops", async () => {
    await renderWithPlanDrift();
    const green = await screen.findByTestId("gantt-drift-green-end-ahead");
    const bar = screen.getByTestId("gantt-bar-ahead");
    expect(num(green, "x")).toBeCloseTo(num(bar, "x") + num(bar, "width"), 1);
  });

  it("never puts amber on the chart — the colour is gone", async () => {
    await renderWithPlanDrift();
    await screen.findByTestId("gantt-drift-red-start-behind");
    expect(document.querySelectorAll('[data-testid*="amber"]').length).toBe(0);
    const marks = Array.from(document.querySelectorAll('[data-testid^="gantt-drift-"]'));
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      expect(m.getAttribute("fill")).not.toContain("#f59e0b");
    }
  });
});

describe("TimelineView — drift style is overlay-vs-bare-canvas", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  it("marks that lie ON the bar are STRIPED, and paint after it", async () => {
    await renderWithPlanDrift();
    const green = await screen.findByTestId("gantt-drift-green-start-ahead");
    const red = screen.getByTestId("gantt-drift-red-end-behind");
    expect(green.getAttribute("fill")).toBe("url(#timeline-drift-green)");
    expect(red.getAttribute("fill")).toBe("url(#timeline-drift-red)");
    // SVG has no z-index: later siblings paint on top.
    const aheadBar = screen.getByTestId("gantt-bar-ahead");
    const behindBar = screen.getByTestId("gantt-bar-behind");
    expect(aheadBar.compareDocumentPosition(green) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(behindBar.compareDocumentPosition(red) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks on BARE CANVAS are flat shadows, and paint before the bar", async () => {
    await renderWithPlanDrift();
    const red = await screen.findByTestId("gantt-drift-red-start-behind");
    const green = screen.getByTestId("gantt-drift-green-end-ahead");
    // A flat colour, NOT a pattern — there is nothing underneath to show through.
    expect(red.getAttribute("fill")).not.toContain("url(");
    expect(green.getAttribute("fill")).not.toContain("url(");
    const behindBar = screen.getByTestId("gantt-bar-behind");
    const aheadBar = screen.getByTestId("gantt-bar-ahead");
    expect(red.compareDocumentPosition(behindBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(green.compareDocumentPosition(aheadBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the two stripe patterns are a matched pair, differing only in colour", async () => {
    await renderWithPlanDrift();
    const g = document.getElementById("timeline-drift-green")!;
    const r = document.getElementById("timeline-drift-red")!;
    for (const attr of ["width", "height", "patternTransform", "patternUnits"]) {
      expect(g.getAttribute(attr)).toBe(r.getAttribute(attr));
    }
    const gl = g.querySelectorAll("line");
    const rl = r.querySelectorAll("line");
    expect(gl.length).toBe(1);
    expect(rl.length).toBe(1);
    for (const attr of ["x1", "y1", "x2", "y2", "stroke-width"]) {
      expect(gl[0].getAttribute(attr)).toBe(rl[0].getAttribute(attr));
    }
    expect(gl[0].getAttribute("stroke")).not.toBe(rl[0].getAttribute("stroke"));
  });
});

describe("TimelineView — one opacity for the plan, and no stray outlines", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  it("every bare-canvas mark shares ONE opacity with the un-started planned bar", async () => {
    await renderWithPlanDrift();
    await screen.findByTestId("gantt-drift-red-start-behind");
    const shadows = [
      screen.getByTestId("gantt-drift-red-start-behind"),
      screen.getByTestId("gantt-drift-green-end-ahead"),
      // `untouched` has no actuals, so its bar IS the plan and is drawn the same.
      screen.getByTestId("gantt-bar-untouched"),
    ].map((el) => Number(el.getAttribute("opacity")));
    expect(new Set(shadows).size).toBe(1);
    // A shadow, not a solid: lighter than the real bar it sits beside.
    const solid = Number(screen.getByTestId("gantt-bar-behind").getAttribute("opacity"));
    expect(shadows[0]).toBeLessThan(solid);
  });

  it("no drift mark carries a border of any kind", async () => {
    await renderWithPlanDrift();
    await screen.findByTestId("gantt-drift-red-start-behind");
    const marks = Array.from(document.querySelectorAll('[data-testid^="gantt-drift-"]'));
    expect(marks.length).toBeGreaterThanOrEqual(4);
    for (const m of marks) {
      // Outlines are reserved for blocked / critical / enabler. A dashed edge
      // here competed with them and said nothing of its own.
      expect(m.getAttribute("stroke")).toBe("none");
      expect(m.getAttribute("stroke-dasharray")).toBeNull();
    }
  });

  it("the un-started planned bar is a shadow, not a dashed outline", async () => {
    await renderWithPlanDrift();
    const bar = await screen.findByTestId("gantt-bar-untouched");
    expect(bar.getAttribute("stroke-dasharray")).toBeNull();
    expect(Number(bar.getAttribute("opacity"))).toBeLessThan(1);
  });
});

describe("TimelineView — a finish with no recorded start", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  it("shows the slip", async () => {
    await renderWithPlanDrift();
    const red = await screen.findByTestId("gantt-drift-red-end-noStart");
    const bar = screen.getByTestId("gantt-bar-noStart");
    expect(screen.queryByTestId("gantt-drift-red-start-noStart")).toBeNull();
    expect(screen.queryByTestId("gantt-drift-green-start-noStart")).toBeNull();
    expect(num(red, "x")).toBeGreaterThan(num(bar, "x"));
  });

  it("an item nobody has touched stays bare, however overdue", async () => {
    await renderWithPlanDrift();
    // Guard the premise: the sibling slip must be on screen, or this passes
    // simply because the lens never drew anything at all.
    await screen.findByTestId("gantt-drift-red-end-noStart");
    for (const c of ["red", "green"]) {
      for (const e of ["start", "end"]) {
        expect(screen.queryByTestId(`gantt-drift-${c}-${e}-untouched`)).toBeNull();
      }
    }
  });
});

// A milestone is a DATE, not a span, so it cannot carry striped or shadow spans.
// It drifts the only way a point can: it moves.
describe("TimelineView — milestone drift", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  const MILESTONES = [
    { ...item(1, "2026-01-20", "2026-01-20"), id: "slipped", ticketNumber: 950, actualStart: null, completedAt: "2026-01-27" },
    { ...item(2, "2026-02-10", "2026-02-10"), id: "onTime", ticketNumber: 951, actualStart: null, completedAt: "2026-02-10" },
  ];

  async function renderMilestones() {
    activeItems = MILESTONES;
    renderTimeline();
    await screen.findByText("Work Items");
    fireEvent.click(screen.getByRole("button", { name: /plan drift/i }));
  }

  it("marks where it was planned and joins it to where it landed", async () => {
    await renderMilestones();
    await screen.findByTestId("gantt-milestone-planned-slipped");
    const connector = screen.getByTestId("gantt-milestone-drift-red-slipped");
    // The connector runs from the planned date forward to the actual one.
    expect(num(connector, "x2")).toBeGreaterThan(num(connector, "x1"));
  });

  it("a milestone that landed on its date shows no drift at all", async () => {
    await renderMilestones();
    await screen.findByTestId("gantt-milestone-planned-slipped");
    expect(screen.queryByTestId("gantt-milestone-planned-onTime")).toBeNull();
    expect(screen.queryByTestId("gantt-milestone-drift-red-onTime")).toBeNull();
    expect(screen.queryByTestId("gantt-milestone-drift-green-onTime")).toBeNull();
  });
});

// The axis is built from the PLANNED dates while the bars and marks are drawn
// from the ACTUAL ones. When an item started earlier than anything was planned,
// the two disagree and the bar lands LEFT of the axis origin, where the
// outermost <svg> clips it away.
describe("TimelineView — the axis covers what is actually drawn", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    vi.clearAllMocks();
  });

  const EARLY_ITEMS = [
    {
      ...item(1, "2026-01-20", "2026-02-01"),
      id: "veryEarly",
      ticketNumber: 950,
      actualStart: "2026-01-05",
      completedAt: "2026-01-28",
    },
  ];

  async function renderEarly() {
    activeItems = EARLY_ITEMS;
    renderTimeline();
    await screen.findByText("Work Items");
    fireEvent.click(screen.getByRole("button", { name: /plan drift/i }));
  }

  it("never lays a bar out left of the axis origin", async () => {
    await renderEarly();
    const bar = await screen.findByTestId("gantt-bar-veryEarly");
    expect(num(bar, "x")).toBeGreaterThanOrEqual(0);
  });

  it("never lays a drift mark left of the axis origin", async () => {
    await renderEarly();
    const green = await screen.findByTestId("gantt-drift-green-start-veryEarly");
    expect(num(green, "x")).toBeGreaterThanOrEqual(0);
  });

  it("lays NOTHING out left of the axis origin, whatever the drift", async () => {
    activeItems = [
      { ...item(1, "2026-01-20", "2026-02-01"), id: "early", ticketNumber: 951, actualStart: "2026-01-05", completedAt: "2026-01-28" },
      { ...item(2, "2026-01-22", "2026-02-05"), id: "late", ticketNumber: 952, actualStart: "2026-01-30", completedAt: "2026-02-20" },
      { ...item(3, "2026-01-25", "2026-02-10"), id: "planOnly", ticketNumber: 953 },
    ];
    renderTimeline();
    await screen.findByText("Work Items");
    fireEvent.click(screen.getByRole("button", { name: /plan drift/i }));
    await screen.findByTestId("gantt-drift-green-start-early");

    const drawn = Array.from(
      document.querySelectorAll('[data-testid^="gantt-bar-"], [data-testid^="gantt-drift-"]'),
    );
    // Guard the premise: if the fixture stopped producing marks this would range
    // over bars alone and pass while proving nothing.
    expect(drawn.length).toBeGreaterThanOrEqual(5);
    const offscreen = drawn
      .filter((el) => Number(el.getAttribute("x")) < 0)
      .map((el) => `${el.getAttribute("data-testid")}@x=${el.getAttribute("x")}`);
    expect(offscreen).toEqual([]);
  });
});


// The Blocked lens reads BLOCKS / BLOCKED_BY edges — that part was always right.
// What was missing is that `isBlocked` only ever reached the PLANNED bar's
// stroke, so work that had actually started — which is most of what gets blocked
// — showed no outline at all, only the surrounding dimming.
describe("TimelineView — the Blocked lens outlines started work too", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    activeLinks = [];
    vi.clearAllMocks();
  });

  const BLOCKED_ITEMS = [
    // Underway: has an actual start, so it renders as the SOLID actual bar.
    { ...item(1, "2026-01-05", "2026-01-20"), id: "underway", ticketNumber: 960, actualStart: "2026-01-06" },
    // Untouched: renders as the planned phantom bar.
    { ...item(2, "2026-01-05", "2026-01-20"), id: "notStarted", ticketNumber: 961 },
    // The thing doing the blocking. Not itself blocked.
    { ...item(3, "2026-01-05", "2026-01-20"), id: "blocker", ticketNumber: 962 },
  ];

  async function renderBlocked() {
    activeItems = BLOCKED_ITEMS;
    activeLinks = [
      { id: "l1", type: "BLOCKS", sourceItemId: "blocker", targetItemId: "underway" },
      { id: "l2", type: "BLOCKS", sourceItemId: "blocker", targetItemId: "notStarted" },
    ];
    renderTimeline();
    await screen.findByText("Work Items");
    fireEvent.click(screen.getByRole("button", { name: /^blocked$/i }));
  }

  it("outlines a blocked item that has ALREADY STARTED", async () => {
    await renderBlocked();
    const bar = await screen.findByTestId("gantt-bar-underway");
    expect(bar.getAttribute("stroke")).toBe("var(--status-critical)");
    expect(num(bar, "stroke-width")).toBe(2.5);
  });

  it("still outlines a blocked item that has not started", async () => {
    await renderBlocked();
    const bar = await screen.findByTestId("gantt-bar-notStarted");
    expect(bar.getAttribute("stroke")).toBe("var(--status-critical)");
    expect(num(bar, "stroke-width")).toBe(2.5);
  });

  it("leaves an unblocked item's outline alone", async () => {
    await renderBlocked();
    const bar = await screen.findByTestId("gantt-bar-blocker");
    expect(bar.getAttribute("stroke")).not.toBe("var(--status-critical)");
  });
});

describe("TimelineView — lens dimming does not compound", () => {
  afterEach(() => {
    cleanup();
    activeItems = ITEMS;
    activeLinks = [];
    vi.clearAllMocks();
  });

  it("two active lenses dim to the STRONGEST factor, not the product of both", async () => {
    activeItems = [
      { ...item(1, "2026-01-05", "2026-01-20"), id: "plain", ticketNumber: 970 },
      { ...item(2, "2026-01-05", "2026-01-20"), id: "other", ticketNumber: 971 },
    ];
    activeLinks = [{ id: "l1", type: "BLOCKS", sourceItemId: "other", targetItemId: "plain" }];
    renderTimeline();
    await screen.findByText("Work Items");

    const bar = () => screen.getByTestId("gantt-bar-other");
    const base = Number(bar().getAttribute("opacity"));

    // `other` is neither blocked nor an enabler, so BOTH lenses dim it: 0.35 and
    // 0.4. Multiplied that is 0.14; the strongest single factor is 0.35.
    fireEvent.click(screen.getByRole("button", { name: /^blocked$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^enablers$/i }));
    const dimmed = Number(bar().getAttribute("opacity"));

    expect(dimmed).toBeLessThan(base);
    expect(dimmed).toBeCloseTo(base * 0.35, 5);
    expect(dimmed).not.toBeCloseTo(base * 0.35 * 0.4, 5);
  });
});
