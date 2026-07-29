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
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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

// The work-items the fetcher mock serves; swapped per describe block so a test
// can opt into the hierarchy without changing the default flat dataset.
let activeItems: unknown[] = ITEMS;
// Real Milestone rows, as the milestones API returns them. Dated inside the
// window the ITEMS fixture spans so a marker has somewhere to land.
let activeMilestones: unknown[] = [];

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

import { TimelineView, matchesFilters } from "./timeline-view";
import { jsonFetch } from "@/lib/query/json-fetcher";
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
      intervalId: null,
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

// Reported: "the milestones in the gantt aren't populating in the milestones
// board." The two surfaces were reading different things — the Milestones board
// reads the Milestone table, while this Gantt inferred a "milestone" from any
// work item whose start and due dates matched and never read that table at all.
// So a real milestone was invisible here, and the diamonds it drew were work
// items. These lock the Gantt onto the same rows the Milestones board shows.
describe("TimelineView — milestones come from the milestone table", () => {
  afterEach(() => {
    activeMilestones = [];
  });

  it("renders a marker for a milestone it did not create", async () => {
    activeMilestones = [
      { id: "m1", title: "Beta cutover", dueDate: "2026-01-15T00:00:00.000Z", status: "UPCOMING" },
    ];
    renderTimeline();

    const markers = await screen.findAllByTestId("gantt-milestone");
    expect(markers).toHaveLength(1);
    // Deep-links to the one milestones surface rather than a Gantt-local editor,
    // so there is a single place a milestone is edited.
    expect(markers[0].querySelector("a")?.getAttribute("href")).toBe(
      "/acme/projects/FSC/milestones?open=m1",
    );
  });

  it("shows every dated milestone, not just ones matching a work item", async () => {
    activeMilestones = [
      { id: "m1", title: "Beta cutover", dueDate: "2026-01-15T00:00:00.000Z" },
      { id: "m2", title: "GA", dueDate: "2026-01-22T00:00:00.000Z" },
    ];
    renderTimeline();
    expect(await screen.findAllByTestId("gantt-milestone")).toHaveLength(2);
  });

  it("skips undated milestones rather than stacking them at the origin", async () => {
    activeMilestones = [
      { id: "m1", title: "Someday", dueDate: null },
      { id: "m2", title: "GA", dueDate: "2026-01-22T00:00:00.000Z" },
    ];
    renderTimeline();
    // A null date has nowhere honest to sit; placing it at day 0 would claim a
    // deadline the milestone does not have.
    expect(await screen.findAllByTestId("gantt-milestone")).toHaveLength(1);
  });
});

// Zoom replaced the old Compress/Expand controls. Those MUTATED the schedule —
// they rewrote every item's dates by a factor — so "look wider" and "change the
// plan" were the same button. Zoom changes only how the same dates are drawn.
describe("TimelineView — zoom replaces the destructive scale controls", () => {
  it("no longer offers Compress/Expand", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    // Their absence is the point: rescheduling every item is not a view control.
    expect(screen.queryByRole("button", { name: /compress/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^expand$/i })).toBeNull();
  });

  it("offers zoom controls and a reset, to everyone", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("widens the chart when zooming in and restores it on reset", async () => {
    renderTimeline();
    const chart = await screen.findByTestId("gantt-chart");
    const base = chart.style.width;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = screen.getByTestId("gantt-chart").style.width;
    expect(parseFloat(zoomed)).toBeGreaterThan(parseFloat(base));
    expect(screen.getByText("125%")).toBeTruthy();

    // The percentage doubles as the reset control.
    fireEvent.click(screen.getByText("125%"));
    expect(screen.getByTestId("gantt-chart").style.width).toBe(base);
  });

  it("scales the work-items column text with the zoom", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");
    const before = screen.getByTestId("gantt-left").style.fontSize;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("gantt-left").style.fontSize).not.toBe(before);
  });
});

// Fullscreen: "shows only work items column and calendar portion of gantt". The
// board tabs, project header and app sidebar belong to ancestors of this view,
// so a fixed overlay is the only way it can hand the plan the whole viewport.
describe("TimelineView — fullscreen shows only the work items and the calendar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("takes over the viewport with both panes, and drops the chrome around them", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");
    // The toolbar is on screen to begin with — otherwise its absence below
    // would prove nothing.
    expect(screen.getByRole("button", { name: "Critical path" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    // A fixed layer over everything the surrounding app drew.
    const root = screen.getByTestId("gantt-root");
    expect(root.className).toMatch(/\bfixed\b/);
    expect(root.className).toMatch(/\binset-0\b/);

    // The two panes the user asked for are still there, inside that layer...
    expect(root.contains(screen.getByTestId("gantt-left"))).toBe(true);
    expect(root.contains(screen.getByTestId("gantt-chart"))).toBe(true);
    // ...and nothing else is: no lens toolbar, no zoom controls.
    expect(screen.queryByRole("button", { name: "Critical path" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  });

  it("leaves on Escape and on the overlay's own exit control", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(screen.getByTestId("gantt-root").className).toMatch(/\bfixed\b/);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("gantt-root").className).not.toMatch(/\bfixed\b/);
    // The toolbar comes back with it.
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();

    // The overlay also carries a visible way out — Escape can't be the only one.
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(screen.getByTestId("gantt-root").className).toMatch(/\bfixed\b/);
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(screen.getByTestId("gantt-root").className).not.toMatch(/\bfixed\b/);
  });

  it("lets Escape close an open work item without tearing down the view", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    // Open a ticket from the work-items column, then hit Escape: that keypress
    // belongs to the detail sheet. Dismissing both would drop the user back on
    // the board wondering where the ticket went.
    fireEvent.click(screen.getByTitle(/^FSC-101:/));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("gantt-root").className).toMatch(/\bfixed\b/);
  });

  it("keeps the zoom the user chose across entering and leaving", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = screen.getByTestId("gantt-chart").style.width;

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    // Fullscreen is a layout change, not a reset: the chart is still drawn at
    // the scale the user picked before entering.
    expect(screen.getByTestId("gantt-chart").style.width).toBe(zoomed);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("gantt-chart").style.width).toBe(zoomed);
    expect(screen.getByText("125%")).toBeTruthy();
  });
});

// Shift used to move EVERY visible item, so nudging two tasks by a day silently
// re-dated the whole board. It now moves the rows the user ticked, and nothing
// else — and with nothing ticked it refuses to run rather than falling back to
// "then move everything", which is the behaviour being fixed.
describe("TimelineView — Shift moves only the selected work items", () => {
  // Local midnight of an ISO date, matching the component's day snapping, so the
  // day-delta assertions don't depend on the machine's timezone.
  const localMidnight = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const puts = () =>
    vi.mocked(jsonFetch).mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
  const count = () => screen.getByTestId("gantt-selection-count").textContent;

  beforeEach(() => {
    perms.canEdit = true;
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    perms.canEdit = false;
    activeItems = ITEMS;
    window.sessionStorage.clear();
  });

  it("refuses to shift while nothing is selected, and says what to do", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    expect(screen.getByRole("button", { name: "+1d" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "-7d" })).toBeDisabled();
    // A disabled button's `title` never surfaces (pointer-events are off), so
    // the reason has to be on screen.
    expect(count()).toMatch(/select items/i);
  });

  it("moves the ticked row and leaves the rest of the board where it was", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    fireEvent.click(screen.getByLabelText("Select FSC-102"));
    expect(count()).toBe("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "+1d" }));
    await waitFor(() => expect(puts()).toHaveLength(1));

    // Exactly one item was rewritten: the one that was ticked.
    expect(puts()[0][0]).toBe("/api/v1/orgs/o1/projects/p1/work-items/i2");
    const body = JSON.parse(String((puts()[0][1] as RequestInit).body));
    // ...and it moved by the day the button promised, not by 0 or by 7.
    expect(new Date(body.startDate).getTime() - localMidnight("2026-01-10")).toBe(86_400_000);
    expect(new Date(body.dueDate).getTime() - localMidnight("2026-02-01")).toBe(86_400_000);
  });

  it("shifts several selected rows together", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    fireEvent.click(screen.getByLabelText("Select FSC-101"));
    fireEvent.click(screen.getByLabelText("Select FSC-103"));
    expect(count()).toBe("2 selected");

    fireEvent.click(screen.getByRole("button", { name: "-7d" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts().map((c) => c[0]).sort()).toEqual([
      "/api/v1/orgs/o1/projects/p1/work-items/i1",
      "/api/v1/orgs/o1/projects/p1/work-items/i3",
    ]);
  });

  it("clears the selection on demand, disarming Shift again", async () => {
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    fireEvent.click(screen.getByLabelText("Select all work items"));
    expect(count()).toBe("3 selected");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(count()).toMatch(/select items/i);
    expect(screen.getByRole("button", { name: "+1d" })).toBeDisabled();
  });

  it("drops a row from the selection once it leaves the view", async () => {
    activeItems = HIER_ITEMS;
    renderTimeline();
    await screen.findByTestId("gantt-chart");

    fireEvent.click(screen.getByLabelText("Select FSC-2"));
    expect(count()).toBe("1 selected");

    // Collapsing the epic takes the story off screen. Shifting an item the user
    // can no longer see is the same invisible bulk edit the selection prevents.
    fireEvent.click(screen.getByLabelText("Collapse children"));
    expect(count()).toMatch(/select items/i);
    expect(screen.getByRole("button", { name: "+1d" })).toBeDisabled();
  });
});
