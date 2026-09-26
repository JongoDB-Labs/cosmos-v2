// @vitest-environment jsdom
// COSMOS-189, second pass. The first pass kept a filtered-out parent on the
// Gantt so its matching child stayed nested — the decided behaviour — but
// rendered that parent as an ORDINARY ROW. Two verifiers drove the real screen
// and refused it, for two consequences of that one shortfall:
//
//   1. With the epic COLLAPSED and a filter applied, the chart drew exactly one
//      row — the epic, belonging to somebody else — and the item that actually
//      matched vanished. The filter hid the only thing it had matched.
//   2. With the epic expanded, it was drawn at full strength, identical to a
//      genuine match, and counted in "2 selected" — so "shift everything I have
//      selected" would re-plan an epic the filter had just said was not yours.
//
// The decision itself (keep the ancestor) is not what was wrong; presenting it
// as a RESULT was. These tests pin the distinction: a structural row stays on
// the chart, and is not a result — not selectable, not counted, not draggable,
// visibly faded, and never able to swallow the match it exists to carry.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/TEST/boards/b1",
}));

// The selection UI (row checkboxes, select-all, the "N selected" counter) is
// gated on ITEM_UPDATE, and `usePermissions` falls back to VIEWER outside a
// provider — so an editor has to be mocked in or half of this is unreachable.
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({
  NewIssueButton: () => null,
}));
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: () => null,
}));

// Stubbed to the one thing under test — the assignee filter the verifier set —
// leaving the rest of the module real.
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
        <button onClick={() => onFilterChange({ ...filters, assigneeId: "u-alice" })}>
          Assignee: Alice
        </button>
        <button onClick={() => onFilterChange({ ...filters, assigneeId: null })}>
          Assignee: anyone
        </button>
      </div>
    ),
  };
});

const item = (
  id: string,
  ticketNumber: number,
  title: string,
  parentId: string | null,
  assigneeId: string | null,
) => ({
  id,
  ticketNumber,
  title,
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

// The verifier's own fixture: an epic owned by Bob with one story owned by
// Alice under it, plus a second story of Bob's so the filter has something to
// remove outright.
const ITEMS = [
  item("epic-alpha", 21, "VERIFY Epic Alpha", null, "u-bob"),
  item("story-a1", 22, "VERIFY Story A1", "epic-alpha", "u-alice"),
  item("story-b1", 23, "VERIFY Story B1", "epic-alpha", "u-bob"),
];

const MEMBERS = [
  { userId: "u-alice", user: { displayName: "Alice", email: "alice@x.test" } },
  { userId: "u-bob", user: { displayName: "Bob", email: "bob@x.test" } },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/teams")) return Promise.resolve([]);
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

import { jsonFetch } from "@/lib/query/json-fetcher";
import { TimelineView } from "./timeline-view";

async function renderTimeline() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="TEST" boardId="b1" />
    </QueryClientProvider>,
  );
  await screen.findByText("Work Items");
  await screen.findByTestId("gantt-bar-story-a1");
  return utils;
}

const filterToAlice = () => fireEvent.click(screen.getByText("Assignee: Alice"));

/** The bar element for a row, or null when the row is not on the chart. */
const bar = (id: string) => screen.queryByTestId(`gantt-bar-${id}`);

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("Gantt structural rows — collapse must not swallow the match", () => {
  it("still draws the match when its kept-for-structure parent was collapsed", async () => {
    await renderTimeline();
    // Collapse the epic FIRST, exactly as the verifier did.
    fireEvent.click(screen.getByLabelText("Collapse children"));
    expect(bar("story-a1")).toBeNull(); // collapsed: subtree hidden, as designed

    filterToAlice();

    // The reported failure was one row, `epic-alpha`, and no Alice item at all.
    expect(bar("story-a1")).not.toBeNull();
    expect(bar("epic-alpha")).not.toBeNull();
    expect(bar("story-b1")).toBeNull();
  });

  it("disables the collapse control on a held-open structural row", async () => {
    await renderTimeline();
    const chevron = screen.getByLabelText("Collapse children");
    expect(chevron).not.toBeDisabled();
    fireEvent.click(chevron);
    // Now collapsed, by the user's own hand.
    expect(screen.getByLabelText("Expand children")).not.toBeDisabled();

    filterToAlice();

    // Held open — so it reports expanded — and not clickable, because the only
    // thing collapsing it could do is hide the match it is carrying.
    const held = screen.getByLabelText("Collapse children");
    expect(held).toBeDisabled();
    expect(held.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(held);
    expect(bar("story-a1")).not.toBeNull();
  });

  it("restores the user's own collapse state once the filter is cleared", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByLabelText("Collapse children"));
    filterToAlice();
    // Back to all assignees: the epic matches again, so it is a normal row and
    // the collapse the user asked for is still in force — force-expanding is a
    // VIEW of their collapse set, never a write to it.
    fireEvent.click(screen.getByText("Assignee: anyone"));

    expect(screen.getByLabelText("Expand children")).toBeTruthy();
    expect(bar("story-a1")).toBeNull();
  });
});

describe("Gantt structural rows — context, not a result", () => {
  it("does not count the non-matching epic in the selection", async () => {
    await renderTimeline();
    filterToAlice();
    fireEvent.click(screen.getByLabelText("Select all work items"));

    // The reported failure was "2 selected" — Alice's story plus Bob's epic.
    expect(screen.getByTestId("gantt-selection-count").textContent).toBe("1 selected");
  });

  it("offers no checkbox on the structural row", async () => {
    await renderTimeline();
    expect(screen.getByLabelText("Select TEST-21")).toBeTruthy();

    filterToAlice();

    expect(screen.queryByLabelText("Select TEST-21")).toBeNull();
    expect(screen.getByLabelText("Select TEST-22")).toBeTruthy();
  });

  it("does not select the structural row when its bar is clicked", async () => {
    await renderTimeline();
    filterToAlice();
    fireEvent.click(bar("epic-alpha")!);

    expect(screen.getByTestId("gantt-selection-count").textContent).toBe(
      "Select items to shift",
    );
  });

  it("draws the structural bar faded, not at the same strength as the match", async () => {
    await renderTimeline();
    // Measured against THIS fixture's own unfiltered strength rather than a
    // literal: these items have no actual start, so their bars are already
    // drawn at the phantom opacity and a hardcoded 1 would be asserting the
    // wrong thing. The claim is relative — the epic recedes, the match does not.
    const epicBefore = Number(bar("epic-alpha")!.getAttribute("opacity"));
    const matchBefore = Number(bar("story-a1")!.getAttribute("opacity"));

    filterToAlice();

    const epicAfter = Number(bar("epic-alpha")!.getAttribute("opacity"));
    const matchAfter = Number(bar("story-a1")!.getAttribute("opacity"));
    expect(matchAfter).toBe(matchBefore);
    expect(epicAfter).toBeLessThan(epicBefore);
    expect(epicAfter).toBeLessThan(matchAfter);
  });

  it("says on the row itself why a non-matching epic is on the chart", async () => {
    await renderTimeline();
    filterToAlice();

    expect(
      screen.getByTitle(/TEST-21: VERIFY Epic Alpha — shown for context/),
    ).toBeTruthy();
    // The genuine match keeps its plain label.
    expect(screen.getByTitle("TEST-22: VERIFY Story A1")).toBeTruthy();
  });

  // The three below all clear the filter again before asserting. That is not
  // ceremony: while the filter is ON, the count is honest even if a structural
  // id has been let into the selection, because the count filters it out at the
  // last moment. Clearing the filter promotes that row back to an ordinary one
  // and the stowaway becomes visible — as a row the user never ticked, now
  // armed under the Shift buttons. Asserting only the filtered count would let
  // every one of these leaks through.
  it("drops a row from the count once a filter demotes it to structure", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByLabelText("Select all work items"));
    expect(screen.getByTestId("gantt-selection-count").textContent).toBe("3 selected");

    filterToAlice();

    expect(screen.getByTestId("gantt-selection-count").textContent).toBe("1 selected");
  });

  it("does not quietly tick the structural row when selecting everything", async () => {
    await renderTimeline();
    filterToAlice();
    fireEvent.click(screen.getByLabelText("Select all work items"));
    fireEvent.click(screen.getByText("Assignee: anyone"));

    // Bob's epic was never a candidate, so clearing the filter must not reveal
    // it sitting in the selection.
    expect(screen.getByTestId("gantt-selection-count").textContent).toBe("1 selected");
  });

  it("keeps a clicked structural bar out of the selection after the filter clears", async () => {
    await renderTimeline();
    filterToAlice();
    fireEvent.click(bar("epic-alpha")!);
    fireEvent.click(screen.getByText("Assignee: anyone"));

    expect(screen.getByTestId("gantt-selection-count").textContent).toBe(
      "Select items to shift",
    );
  });

  it("will not reschedule a structural bar by dragging it", async () => {
    await renderTimeline();
    filterToAlice();

    // The same gesture the Gantt's own drag tests use — past the 3px threshold
    // and committed on pointerup. A committed drag writes the new dates with a
    // PUT, so no PUT is the view declining to move Bob's epic.
    fireEvent.pointerDown(bar("epic-alpha")!, { clientX: 0 });
    fireEvent.pointerMove(bar("epic-alpha")!, { clientX: 60 });
    fireEvent.pointerUp(bar("epic-alpha")!, { clientX: 60 });

    const puts = () =>
      vi
        .mocked(jsonFetch)
        .mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(puts()).toHaveLength(0);

    // The counterweight: the genuine match is still draggable, so this asserts
    // a refusal rather than a chart on which nothing can be dragged at all.
    fireEvent.pointerDown(bar("story-a1")!, { clientX: 0 });
    fireEvent.pointerMove(bar("story-a1")!, { clientX: 60 });
    fireEvent.pointerUp(bar("story-a1")!, { clientX: 60 });
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it("leaves every row a normal, selectable result when no filter is applied", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByLabelText("Select all work items"));

    expect(screen.getByTestId("gantt-selection-count").textContent).toBe("3 selected");
    // Same strength as its children — nothing is structural without a filter.
    expect(Number(bar("epic-alpha")!.getAttribute("opacity"))).toBe(
      Number(bar("story-a1")!.getAttribute("opacity")),
    );
    expect(
      within(screen.getByTestId("gantt-left")).getByLabelText("Select TEST-21"),
    ).toBeTruthy();
  });
});
