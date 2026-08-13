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
  mkItem({ id: "1", ticketNumber: 1, title: "Payment retries", priority: "CRITICAL", intervalId: "s1" }),
  mkItem({ id: "2", ticketNumber: 2, title: "Payment webhooks", priority: "CRITICAL", intervalId: "s1" }),
  mkItem({ id: "3", ticketNumber: 3, title: "Nav polish", priority: "LOW" }),
  mkItem({ id: "4", ticketNumber: 4, title: "Nav icons", priority: "LOW" }),
  mkItem({ id: "5", ticketNumber: 5, title: "Nav spacing", priority: "LOW" }),
];

/**
 * The shape that broke the burndown: a Program Increment numbered ABOVE its
 * sprints, ACTIVE for as long as any sprint inside it runs, holding no work
 * items of its own. The intervals API orders by number DESC, so a plain
 * `.find(i => i.status === "ACTIVE")` returns the PI and the widget reports
 * "No active sprint data" while a sprint is plainly running.
 */
const NOW = new Date();
const iso = (offsetDays: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
};

const INTERVALS = [
  {
    id: "pi1",
    number: 100,
    name: "PI-002",
    status: "ACTIVE",
    intervalKind: "PROGRAM_INCREMENT",
    parentId: null,
    startDate: iso(-30),
    endDate: iso(60),
    report: null,
  },
  {
    id: "s1",
    number: 6,
    name: "Sprint 6",
    status: "ACTIVE",
    intervalKind: "SPRINT",
    parentId: "pi1",
    startDate: iso(-5),
    endDate: iso(5),
    report: null,
  },
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
          : u.includes("/intervals")
          ? INTERVALS
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

describe("Sprint Health — the delivery panels are actually reachable", () => {
  it("puts throughput and cycle time on the Trend tab", async () => {
    // A panel that renders correctly in isolation and is wired to no tab is the
    // same defect as no panel at all. This asserts the route from the tab the
    // user clicks to the analysis they came for.
    renderBoard();
    await waitFor(() => expect(screen.getAllByTestId("metric-total-items").length).toBeGreaterThan(0));

    // "Trend across sprints" previously held a velocity bar list and nothing else.
    expect(screen.queryByText(/Once we start something/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Trend across sprints/i }));

    await waitFor(() => {
      expect(screen.getByText(/How many items are we finishing per sprint\?/)).toBeInTheDocument();
      expect(screen.getByText(/Once we start something, how long until it is done\?/)).toBeInTheDocument();
    });
  });

  it("does not draw the work-type heading twice inside the grid cell", async () => {
    // The grid cell supplies its own border and <h3>. A self-titling panel
    // dropped into it renders the heading and the card outline twice — obvious
    // on screen, and completely invisible to a typecheck. `bare` suppresses the
    // panel's own chrome; the grid's title is the one that must survive.
    renderBoard();

    await waitFor(() => expect(screen.getAllByText("Work Type Mix").length).toBeGreaterThan(0));
    // The panel's own heading text, which differs only in capitalisation.
    expect(screen.queryAllByText("Work type mix")).toHaveLength(0);
  });

  it("narrows the work type mix when a filter is applied", async () => {
    // The mix is computed from the FILTERED set, like every other number here.
    // Reading the whole project on a board showing a filter bar is the exact
    // bug #683 fixed for the metrics; it must not come back one panel at a time.
    renderBoard();

    await waitFor(() => {
      const rows = screen.getAllByTestId("work-type-unknown");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((el) => expect(el).toHaveTextContent("5 · 100%"));
    });

    fireEvent.change(screen.getAllByPlaceholderText(/search/i)[0], {
      target: { value: "Payment" },
    });

    await waitFor(() =>
      screen
        .getAllByTestId("work-type-unknown")
        .forEach((el) => expect(el).toHaveTextContent("2 · 100%")),
    );
  });
});

describe("Sprint Health — which interval the burndown picks", () => {
  it("charts the running SPRINT, not the Program Increment that contains it", async () => {
    // The reported symptom was "No active sprint data" with a live active
    // sprint. The cause is not the chart: `.find(i => i.status === "ACTIVE")`
    // over every interval returns the PI, because a PI stays ACTIVE for as long
    // as any sprint inside it runs AND is numbered above them while the API
    // sorts number DESC. The PI owns no work items, so scope is 0 and the
    // widget renders its empty state.
    //
    // Both intervals here are ACTIVE and the PI sorts first — exactly the state
    // of a healthy project, which is why this was the normal case rather than
    // an edge one.
    renderBoard();

    await waitFor(() => expect(screen.getAllByTestId("metric-total-items").length).toBeGreaterThan(0));

    // Two items sit in Sprint 6 and none in the PI, so picking the PI yields an
    // empty chart and this message.
    await waitFor(() => expect(screen.queryAllByText(/No active sprint data/i)).toHaveLength(0));
  });
});
