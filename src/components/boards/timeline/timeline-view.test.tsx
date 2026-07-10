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
vi.mock("@/components/boards/shared/filter-bar", () => ({
  FilterBar: () => null,
  bareTypeKey: (k?: string | null) => k ?? "TASK",
  emptyFilters: {
    search: "",
    types: [],
    priorities: [],
    assigneeId: null,
    cycleId: null,
    swimlaneBy: "none",
    customFields: {},
  },
}));

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

import { TimelineView } from "./timeline-view";

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
