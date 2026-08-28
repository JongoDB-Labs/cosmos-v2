// @vitest-environment jsdom
//
// Sprint Health's drill-down opens the ticket, it does not leave the board.
//
// WHY THIS EXISTS: clicking a ticket under "Overdue" was an anchor to
// `/<org>/issues?item=<id>`, so the one board a lead reads to decide what to do
// about overdue work threw them onto the issues list to touch a single ticket —
// while every other board (Table, Calendar, RAID) opens the same editable sheet
// in place. The bug was entirely in the WIRING: BoardItemDetailSheet already
// existed and this surface simply never called it. So what is pinned here is
// that the row is not a navigation, and that the clicked item's id is the one
// handed to the sheet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/projects/ACME/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("react-grid-layout", () => ({
  GridLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  verticalCompactor: () => [],
}));

// Stubbed: the real sheet drags in permissions, custom fields and an editor.
// What matters at this seam is which item id reaches it.
vi.mock("@/components/work-items/board-item-detail-sheet", () => ({
  BoardItemDetailSheet: ({ itemId }: { itemId: string | null }) =>
    itemId ? <div data-testid="detail-sheet">{itemId}</div> : null,
}));

import { DashboardView } from "./dashboard-view";

const BOARD = {
  id: "b1",
  name: "Sprint Health",
  columns: [
    { id: "c1", key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
    { id: "c2", key: "done", name: "Done", category: "DONE", sortOrder: 1 },
  ],
};

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

const mkItem = (over: Record<string, unknown>) => ({
  id: String(over.id),
  title: String(over.title ?? "Item"),
  ticketNumber: Number(over.ticketNumber ?? 1),
  columnKey: "todo",
  priority: "MEDIUM",
  storyPoints: null,
  completedAt: null,
  dueDate: null,
  intervalId: null,
  assigneeId: null,
  createdById: "u1",
  workCategory: "BUSINESS",
  tags: [],
  customFields: {},
  ...over,
});

// One overdue item and one that is merely open, so the drill-down list has
// exactly one row to click and clicking it cannot be ambiguous.
const ITEMS = [
  mkItem({ id: "late-1", ticketNumber: 11, title: "Payment retries", dueDate: daysAgo(3) }),
  mkItem({ id: "ok-1", ticketNumber: 12, title: "Nav polish" }),
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes("/interval-changes")
        ? { changes: [], truncated: false }
        : u.includes("/boards/")
        ? BOARD
        : u.includes("/work-items") && !u.includes("work-item-types")
        ? ITEMS
        : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardView orgId="o1" projectId="p1" projectKey="ACME" boardId="b1" />
    </QueryClientProvider>,
  );
}

/** Opens the Overdue drill-down and returns [the list, its single row]. */
async function openOverdueDrill() {
  renderBoard();
  await waitFor(() => expect(screen.getAllByTestId("metric-overdue").length).toBeGreaterThan(0));
  // The component renders a mobile stack and the (mocked) desktop grid, so
  // every widget appears twice; either card drills into the same list.
  fireEvent.click(screen.getAllByText("Overdue")[0]);
  // Scoped to the dialog: the activity feed on the board behind it lists the
  // same ticket, so a bare text query matches three nodes.
  const list = await screen.findByRole("dialog");
  const row = await within(list).findByText("Payment retries");
  return { list, row };
}

beforeEach(() => {
  vi.restoreAllMocks();
  stubFetch();
});

describe("Sprint Health — overdue drill-down", () => {
  it("opens the ticket in the detail sheet instead of navigating to Issues", async () => {
    const { row } = await openOverdueDrill();

    // The load-bearing half: nothing opens the ticket before it is clicked.
    expect(screen.queryByTestId("detail-sheet")).toBeNull();

    fireEvent.click(row);

    const sheet = await screen.findByTestId("detail-sheet");
    expect(
      sheet.textContent,
      "the sheet must load the ticket that was actually clicked",
    ).toBe("late-1");
  });

  it("does not render the drill-down rows as links to the issues page", async () => {
    const { list, row } = await openOverdueDrill();

    // A row that is still an anchor is still a full page navigation, even if a
    // sheet happens to open behind it.
    expect(row.closest("a, button")?.tagName).toBe("BUTTON");
    expect(list.querySelector('a[href*="/issues?item="]')).toBeNull();
  });

  it("closes the drill-down list once the ticket is open", async () => {
    // Two stacked modals fight over the focus trap; the ticket is what the
    // reader asked for.
    const { row } = await openOverdueDrill();
    fireEvent.click(row);

    await screen.findByTestId("detail-sheet");
    await waitFor(() => expect(screen.queryByText(/Overdue · 1 item$/)).toBeNull());
  });
});
