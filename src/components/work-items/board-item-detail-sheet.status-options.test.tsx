// @vitest-environment jsdom
//
// Where the Status options come from when the host board owns no columns.
//
// WHY THIS EXISTS: the ticket opened from Sprint Health's overdue drill-down
// showed `review` in its Status control — the raw `columnKey` — over a menu with
// ZERO options, so the one field a lead chases an overdue item to change could
// not be changed.
//
// Not a dashboard bug. `POST /boards` seeds a new board's columns from
// `BOARD_TYPE_REGISTRY[type].defaultColumns`, and only SPRINT_PLANNING and
// SPRINT_REVIEW declare any — so DASHBOARD, TABLE, CALENDAR and RAID, i.e.
// EVERY type that reaches this sheet, own zero columns. `columnKey` is a
// PROJECT-level value; the options have to come from the project.
//
// A typecheck cannot see any of this: `columns={[]}` is perfectly well-typed and
// the sheet renders happily with an empty option list. The assertion has to be
// on the options that reach the control.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@/types/models";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/ENG" }));

// Mirrors the one line of CardDetailSheet this wrapper feeds:
// `const statusOptions = statusColumns ?? columns`. Rendering the resulting
// labels means the test asserts what the Status control can OFFER, not merely
// which prop got set.
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: ({
    open,
    columns,
    statusColumns,
  }: {
    open: boolean;
    columns: { key: string; name: string }[];
    statusColumns?: { key: string; name: string }[];
  }) =>
    open ? (
      <ul data-testid="status-options">
        {(statusColumns ?? columns).map((c) => (
          <li key={c.key} data-key={c.key}>
            {c.name}
          </li>
        ))}
      </ul>
    ) : null,
}));

const jsonFetchMock = vi.fn();
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: (...args: unknown[]) => jsonFetchMock(...args),
}));

import { BoardItemDetailSheet } from "@/components/work-items/board-item-detail-sheet";

const ITEM = { id: "W1", title: "Falcon SSO integration", columnKey: "review" } as WorkItem;

// What a real project looks like: the workflow lives on the delivery board, and
// the board the user happens to be standing on owns nothing.
const DELIVERY_COLUMNS = [
  { key: "backlog", name: "Backlog", sortOrder: 0 },
  { key: "todo", name: "To Do", sortOrder: 1 },
  { key: "in-progress", name: "In Progress", sortOrder: 2 },
  { key: "review", name: "Review", sortOrder: 3 },
  { key: "done", name: "Done", sortOrder: 4 },
];

const ALL_LABELS = ["Backlog", "To Do", "In Progress", "Review", "Done"];

function setup(hostBoardId = "host") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BoardItemDetailSheet
        itemId="W1"
        onOpenChange={() => {}}
        orgId="org"
        projectId="proj"
        boardId={hostBoardId}
      />
    </QueryClientProvider>,
  );
}

function optionLabels() {
  return Array.from(screen.getByTestId("status-options").children).map((li) => li.textContent);
}

/** Host board owns no columns — the state every affected board type is in. */
function stubColumnlessHost() {
  jsonFetchMock.mockImplementation((url: string) =>
    url.endsWith("/work-items/W1")
      ? Promise.resolve(ITEM)
      : url.endsWith("/boards/host")
      ? Promise.resolve({ id: "host", name: "Sprint Health", columns: [] })
      : url.endsWith("/boards")
      ? Promise.resolve([
          { id: "host", name: "Sprint Health", columns: [] },
          { id: "delivery", name: "Board", columns: DELIVERY_COLUMNS },
        ])
      : Promise.resolve([]),
  );
}

afterEach(() => {
  cleanup();
  jsonFetchMock.mockReset();
});

describe("BoardItemDetailSheet — Status options on a board with no columns", () => {
  it("offers the project's statuses, not the host board's empty column list", async () => {
    stubColumnlessHost();
    setup();

    await waitFor(() => expect(screen.getByTestId("status-options")).toBeTruthy());
    // All five, in workflow order — the same list the delivery board and the
    // Issues page this drill-down replaced already show.
    await waitFor(() => expect(optionLabels()).toEqual(ALL_LABELS));
    // And the item's own status is among them, so the control has a human label
    // to render instead of falling back to the raw key.
    expect(
      screen.getByTestId("status-options").querySelector('[data-key="review"]')?.textContent,
      'the ticket sat in "review" and the control printed that raw key',
    ).toBe("Review");
  });

  it("does not depend on the host board having columns at all", async () => {
    // Calendar and RAID pass a boardId whose board is equally empty; Table's is
    // too. Whatever the host is, the options come from the project.
    stubColumnlessHost();
    setup("host");

    await waitFor(() => expect(optionLabels()).toEqual(ALL_LABELS));
  });

  it("keeps the host board's own columns while the project list is still loading", async () => {
    // The guard this depends on: an EMPTY `statusColumns` would win over the
    // board's columns, because the sheet reads `statusColumns ?? columns`. A
    // board that does own columns must not lose them for a render.
    jsonFetchMock.mockImplementation((url: string) =>
      url.endsWith("/work-items/W1")
        ? Promise.resolve(ITEM)
        : url.endsWith("/boards/host")
        ? Promise.resolve({ id: "host", name: "Kanban", columns: DELIVERY_COLUMNS })
        : url.endsWith("/boards")
        ? new Promise(() => {}) // never resolves
        : Promise.resolve([]),
    );

    setup();

    await waitFor(() => expect(screen.getByTestId("status-options")).toBeTruthy());
    expect(optionLabels()).toEqual(ALL_LABELS);
  });
});
