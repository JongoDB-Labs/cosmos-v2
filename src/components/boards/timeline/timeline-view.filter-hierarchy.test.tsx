// @vitest-environment jsdom
// COSMOS-189 (Members → Team, phase 4): the Team filter has to behave the same
// way on the timeline/Gantt as it does on the list views.
//
// The Gantt is the only board that draws a HIERARCHY, so it is the only one
// where "hide what does not match" needs a second sentence. It filtered a flat
// item list and rebuilt the tree from the survivors, which meant filtering to a
// team DELETED the epic (nobody is assigned to an epic) and re-rooted that
// team's stories to depth 0 — the filter answered "whose work is this" by
// throwing away "what is it part of".
//
// DECIDED AUTOMATICALLY, nobody having answered the open question: hide the
// non-matching rows, but keep an ancestor that still holds a match, matching
// what a grouped list does with its group headers. These tests pin that, both
// halves of it — the epic survives because a match is under it, and an epic
// with no surviving descendant does not.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

// The real FilterBar's Team control is a base-ui Select and is covered by
// filter-bar.test.tsx. What is under test here is what the VIEW does with the
// filter it is handed, so the bar is stubbed down to a button that sets exactly
// the `teamId` the real control sets. Everything else in the module stays real
// — `emptyFilters` and `bareTypeKey` are what the component ships with.
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return {
    ...actual,
    FilterBar: ({
      filters,
      onFilterChange,
    }: {
      filters: typeof actual.emptyFilters;
      onFilterChange: (f: typeof actual.emptyFilters) => void;
    }) => (
      <div>
        <button onClick={() => onFilterChange({ ...filters, teamId: "t-alpha" })}>
          Filter to Alpha
        </button>
        <button onClick={() => onFilterChange({ ...filters, teamId: null })}>
          All teams
        </button>
      </div>
    ),
  };
});

const item = (
  id: string,
  ticketNumber: number,
  parentId: string | null,
  assigneeId: string | null,
) => ({
  id,
  ticketNumber,
  title: `Item ${ticketNumber}`,
  createdAt: "2026-01-05",
  startDate: "2026-01-05",
  dueDate: "2026-01-20",
  columnKey: "todo",
  workItemType: { key: parentId ? "STORY" : "EPIC", name: parentId ? "Story" : "Epic" },
  priority: "MEDIUM",
  workCategory: "BUSINESS",
  parentId,
  children: [],
  assigneeId,
  assignees: [],
  actualStart: null,
  storyPoints: null,
  completedAt: null,
  sortOrder: 0,
});

// Two epics. The first has one story per team; the second is Bravo's only.
// Nobody is assigned to either epic — which is normal, and is exactly why a
// team filter that keeps only matching rows erases the structure.
const ITEMS = [
  item("epic-shared", 301, null, null),
  item("story-alpha", 302, "epic-shared", "u-alpha"),
  item("story-bravo", 303, "epic-shared", "u-bravo"),
  item("epic-bravo", 304, null, null),
  item("story-bravo-2", 305, "epic-bravo", "u-bravo"),
];

const TEAMS = [
  { id: "t-alpha", name: "Alpha", members: [{ userId: "u-alpha" }] },
  { id: "t-bravo", name: "Bravo", members: [{ userId: "u-bravo" }] },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/teams")) return Promise.resolve(TEAMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    if (url.endsWith("/milestones")) return Promise.resolve([]);
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

async function renderTimeline() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
  await screen.findByText("Work Items");
  await screen.findByTestId("gantt-bar-story-alpha");
  return utils;
}

/** The rows on screen, by item id, in drawn order. */
const drawnRows = () =>
  ITEMS.map((i) => i.id).filter((id) => screen.queryAllByTestId(`gantt-bar-${id}`).length > 0);

afterEach(cleanup);

describe("Timeline Team filter — non-matching rows go, containing parents stay", () => {
  it("draws every row with no team filter applied", async () => {
    await renderTimeline();
    expect(drawnRows()).toEqual([
      "epic-shared",
      "story-alpha",
      "story-bravo",
      "epic-bravo",
      "story-bravo-2",
    ]);
  });

  it("hides the other team's work but keeps the epic that still holds a match", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByText("Filter to Alpha"));

    expect(drawnRows()).toEqual(["epic-shared", "story-alpha"]);
  });

  it("does not keep an epic whose every descendant was filtered out", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByText("Filter to Alpha"));

    // `epic-bravo` is no more a match than `epic-shared` is — it survives or
    // not purely on whether anything under it did. Nothing did.
    expect(screen.queryByTestId("gantt-bar-epic-bravo")).toBeNull();
    expect(screen.queryByTestId("gantt-bar-story-bravo-2")).toBeNull();
  });

  it("leaves the surviving match NESTED, not re-rooted to the top level", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByText("Filter to Alpha"));

    // The collapse chevron renders only for a row with children IN VIEW, so its
    // presence is the tree saying `story-alpha` is still drawn under its epic.
    // Dropping the ancestor would leave one flat row and no chevron at all.
    expect(screen.getByLabelText("Collapse children")).toBeTruthy();
  });

  it("restores everything when the filter goes back to All teams", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByText("Filter to Alpha"));
    fireEvent.click(screen.getByText("All teams"));

    expect(drawnRows()).toEqual([
      "epic-shared",
      "story-alpha",
      "story-bravo",
      "epic-bravo",
      "story-bravo-2",
    ]);
  });
});
