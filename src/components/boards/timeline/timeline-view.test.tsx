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
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
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
