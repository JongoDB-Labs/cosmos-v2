// @vitest-environment jsdom
//
// Sprint Health honours the board filters.
//
// WHY THIS EXISTS: `matchesFilters` has been the one shared filter predicate
// since #674, and Sprint Health still summarised the whole project — the rule
// existed and this surface simply never called it. That is the defect this
// codebase repeats: a correct rule with one call site. A unit test of the
// predicate would have passed the whole time, so the thing worth pinning is the
// WIRING — that narrowing the filter narrows the numbers on screen.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardView } from "./dashboard-view";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  // useOrgQueryKey reads the slug off the path — without this every query key
  // namespaces under `null` and nothing resolves.
  usePathname: () => "/acme/projects/ACME/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// react-grid-layout needs real layout; the component renders a plain stack at
// <md, which is what jsdom reports, so the desktop grid never mounts here.
vi.mock("react-grid-layout", () => ({
  GridLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  verticalCompactor: () => [],
}));

const BOARD = {
  id: "b1",
  name: "Sprint Health",
  columns: [
    { id: "c1", key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
    { id: "c2", key: "done", name: "Done", category: "DONE", sortOrder: 1 },
  ],
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

// Two CRITICAL items and three LOW ones — so a priority filter must change the
// visible total from 5 to 2.
const ITEMS = [
  mkItem({ id: "1", ticketNumber: 1, title: "Payment retries", priority: "CRITICAL" }),
  mkItem({ id: "2", ticketNumber: 2, title: "Payment webhooks", priority: "CRITICAL" }),
  mkItem({ id: "3", ticketNumber: 3, title: "Nav polish", priority: "LOW" }),
  mkItem({ id: "4", ticketNumber: 4, title: "Nav icons", priority: "LOW" }),
  mkItem({ id: "5", ticketNumber: 5, title: "Nav spacing", priority: "LOW" }),
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      // Default to [] rather than {}: the FilterBar pulls several list
      // endpoints (work-item types, labels, teams) and iterates them, so an
      // object default throws "types is not iterable" from inside a hook and
      // takes the whole render down with it.
      const body = u.includes("/boards/")
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

beforeEach(() => {
  vi.restoreAllMocks();
  stubFetch();
});

describe("Sprint Health — filtering", () => {
  it("offers a filter control at all", async () => {
    // It had none: every number described the whole project.
    renderBoard();
    await waitFor(() => expect(screen.getAllByText(/Total/i).length).toBeGreaterThan(0));
    // The shared FilterBar exposes a search box on every board that mounts it.
    expect(screen.getAllByPlaceholderText(/search/i).length).toBeGreaterThan(0);
  });

  it("NARROWS the metrics when a filter is applied", async () => {
    // The load-bearing test. Asserting the unfiltered total proves nothing —
    // it is identical whether or not the predicate is wired in. Only changing
    // the filter and watching the number move distinguishes "filters applied"
    // from "filter bar rendered next to unfiltered numbers".
    renderBoard();

    // The board renders BOTH a mobile stack and a desktop grid, hiding one with
    // CSS — so every metric appears twice in the DOM. Assert on all of them:
    // if only one copy were filtered that would itself be a bug.
    await waitFor(() => {
      const totals = screen.getAllByTestId("metric-total-items");
      expect(totals.length).toBeGreaterThan(0);
      totals.forEach((t) => expect(t).toHaveTextContent("5"));
    });

    const search = screen.getAllByPlaceholderText(/search/i)[0];
    fireEvent.change(search, { target: { value: "Payment" } });

    await waitFor(() =>
      screen.getAllByTestId("metric-total-items").forEach((t) => expect(t).toHaveTextContent("2")),
    );
  });
});
