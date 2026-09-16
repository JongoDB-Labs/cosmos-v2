// @vitest-environment jsdom
//
// What "done" means on a board that owns no columns.
//
// WHY THIS EXISTS: Sprint Health is a DASHBOARD board, and `POST /boards` seeds
// a board's columns from `BOARD_TYPE_REGISTRY[type].defaultColumns` — which only
// SPRINT_PLANNING and SPRINT_REVIEW declare. So the board this screen renders
// owns ZERO columns, every `columnKey` missed the category map, and the screen
// reported Completed 0 / In Progress 0 with a Status Distribution donut that was
// 100% "TODO" next to tickets plainly sitting in Review and Done. Verified in a
// browser against the seeded project before this test was written.
//
// The existing suite cannot catch it: it hands the board five columns of its
// own, which is the one case that was never broken. This one gives the board
// exactly what the API gives it — nothing — and asserts the numbers still
// describe the tickets.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardView } from "./dashboard-view";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/projects/ACME/boards/dash",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("react-grid-layout", () => ({
  GridLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  verticalCompactor: () => [],
}));

// The workflow lives on the project's delivery board. Sprint Health has none.
const DELIVERY_COLUMNS = [
  { id: "c1", key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
  { id: "c2", key: "in-progress", name: "In Progress", category: "IN_PROGRESS", sortOrder: 1 },
  { id: "c3", key: "review", name: "Review", category: "IN_PROGRESS", sortOrder: 2 },
  { id: "c4", key: "done", name: "Done", category: "DONE", sortOrder: 3 },
];

const DASHBOARD_BOARD = { id: "dash", name: "Sprint Health", columns: [] };
const DELIVERY_BOARD = { id: "kanban", name: "Board", columns: DELIVERY_COLUMNS };

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

// Two finished, one moving, one in review, one waiting: numbers that only come
// out right if the categories were resolved from somewhere.
const ITEMS = [
  mkItem({ id: "1", ticketNumber: 1, columnKey: "done", completedAt: new Date().toISOString() }),
  mkItem({ id: "2", ticketNumber: 2, columnKey: "done", completedAt: new Date().toISOString() }),
  mkItem({ id: "3", ticketNumber: 3, columnKey: "in-progress" }),
  mkItem({ id: "4", ticketNumber: 4, columnKey: "todo" }),
  mkItem({ id: "5", ticketNumber: 5, columnKey: "review" }),
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url).split("?")[0];
      const body = u.endsWith("/boards/dash")
        ? DASHBOARD_BOARD
        : u.endsWith("/boards")
        ? [DASHBOARD_BOARD, DELIVERY_BOARD]
        : u.endsWith("/interval-changes")
        ? { changes: [], truncated: false }
        : u.endsWith("/work-items")
        ? ITEMS
        : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardView orgId="o1" projectId="p1" projectKey="ACME" boardId="dash" />
    </QueryClientProvider>,
  );
}

describe("Sprint Health — categories on a board that owns no columns", () => {
  it("counts Completed and In Progress from the project's workflow", async () => {
    renderBoard();

    // Both rendered copies (mobile stack + grid) must agree; one filtered copy
    // would be its own bug.
    await waitFor(() => {
      const done = screen.getAllByTestId("metric-completed");
      expect(done.length).toBeGreaterThan(0);
      done.forEach((el) => expect(el).toHaveTextContent("2"));
    });
    // "review" maps to IN_PROGRESS as well, so this is 2, not 1 — the category,
    // not the key, is what decides.
    screen
      .getAllByTestId("metric-in-progress")
      .forEach((el) => expect(el).toHaveTextContent("2"));
  });

  it("labels the drill-down rows with the ticket's real status", async () => {
    // The row used to read "todo" for every ticket, because an unmatched
    // columnKey falls back to TODO. That is the same drill-down a lead opens
    // from the Overdue card.
    renderBoard();

    await waitFor(() => expect(screen.getAllByTestId("metric-completed").length).toBeGreaterThan(0));
    screen.getAllByRole("button", { name: /Total Items/i })[0].click();

    const rows = await screen.findAllByRole("button", { name: /ACME-3/ });
    expect(rows[0]).toHaveTextContent("in progress");
  });
});
