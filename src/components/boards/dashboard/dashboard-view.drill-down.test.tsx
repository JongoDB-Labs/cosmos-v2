// @vitest-environment jsdom
//
// Sprint Health's drill-down opens the ticket, it does not leave the board.
//
// WHY THIS EXISTS: clicking a row in the Overdue drill-down was an <a href> to
// `/{org}/issues?item=…`. Every other board — Table, Calendar, RAID — opens the
// same editable sheet in place, so the one surface a lead reaches an overdue
// ticket from was also the one that threw them off the page to edit it, and
// left them on Issues afterwards. Nothing about that is visible to a typecheck:
// an anchor and a button render equally happily.
//
// So the assertion is the WIRING: the clicked ticket's id reaches the detail
// sheet and the sheet loads THAT ticket. CardDetailSheet is stubbed (it pulls
// in permissions, editors and a dozen queries of its own); BoardItemDetailSheet
// itself is real, because the fetch-the-item step is the half that proves the
// modal shows the right ticket rather than an empty shell.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@/types/models";

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

vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: ({ open, item }: { open: boolean; item: WorkItem | null }) =>
    open ? <div data-testid="detail-sheet">{item?.title}</div> : null,
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

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();

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

// One overdue ticket and one that is merely open, so the drill-down list has to
// have picked the right row for the id that reaches the sheet to mean anything.
const ITEMS = [
  mkItem({ id: "w1", ticketNumber: 1, title: "Expired certificate", dueDate: YESTERDAY }),
  mkItem({ id: "w2", ticketNumber: 2, title: "Nav polish" }),
];

// What the board list carries vs. what the single-item endpoint returns: the
// sheet must render the FETCHED ticket, not the summary row it was clicked from.
const FULL_W1 = { ...ITEMS[0], title: "Expired certificate", description: "full record" };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes("/work-items/w1")
        ? FULL_W1
        : u.includes("/work-item-links") || u.includes("/objectives")
        ? []
        : u.includes("/interval-changes")
        ? { changes: [], truncated: false }
        : u.includes("/boards/")
        ? BOARD
        : u.includes("/work-items") && !u.includes("work-item-types")
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
      <DashboardView orgId="o1" projectId="p1" projectKey="ACME" boardId="b1" />
    </QueryClientProvider>,
  );
}

async function openOverdueDrill() {
  renderBoard();
  await waitFor(() =>
    screen.getAllByTestId("metric-overdue").forEach((m) => expect(m).toHaveTextContent("1")),
  );
  fireEvent.click(screen.getAllByRole("button", { name: /Overdue/i })[0]);
  return screen.findByRole("button", { name: /ACME-1/ });
}

describe("Sprint Health — clicking a ticket in the overdue drill-down", () => {
  it("opens the editable ticket sheet instead of navigating to Issues", async () => {
    const row = await openOverdueDrill();

    // The defect in its exact shape: a link off the board.
    expect(row.closest("a")).toBeNull();

    fireEvent.click(row);

    await waitFor(() => expect(screen.getByTestId("detail-sheet")).toBeInTheDocument());
    // The sheet loaded the CLICKED ticket, from the single-item endpoint.
    expect(screen.getByTestId("detail-sheet")).toHaveTextContent("Expired certificate");
    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((args) =>
        String(args[0]).endsWith("/work-items/w1"),
      ),
    ).toBe(true);
  });

  it("closes the drill-down list so the ticket is what has focus", async () => {
    const row = await openOverdueDrill();
    fireEvent.click(row);

    await waitFor(() => expect(screen.getByTestId("detail-sheet")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /ACME-1/ })).toBeNull();
  });
});
