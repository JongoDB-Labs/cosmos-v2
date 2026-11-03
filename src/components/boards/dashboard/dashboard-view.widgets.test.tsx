// @vitest-environment jsdom
//
// A DASHBOARD-family board renders the widgets its builder saved.
//
// WHY THIS EXISTS: `Board.config.widgets` had exactly ONE reader in the whole
// repo — `board-builder.tsx:69`, the builder reloading its own state — and
// `lib/boards/widget-registry.ts` (the intended render seam) had zero
// references outside its own file. So the builder saved a layout nothing could
// ever display: a definition with no consumer, the defect this codebase keeps
// repeating. A unit test of the registry would have passed the entire time, so
// the thing worth pinning is the WIRING — that what the builder WROTE is what
// the board SHOWS, and that a board with nothing saved still shows the
// hard-coded default panels it always did.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardView } from "./dashboard-view";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/projects/ACME/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// jsdom reports no layout, so the real grid cannot place anything. The stub
// re-exposes the `layout` array it was handed, which is the one thing THIS file
// can honestly check about positioning: that the saved x/y/w/h reach the grid
// unchanged. The pixels react-grid-layout then draws are asserted against the
// REAL library in `widget-grid.test.tsx`.
vi.mock("react-grid-layout", () => ({
  GridLayout: ({
    children,
    layout,
  }: {
    children?: React.ReactNode;
    layout?: unknown;
  }) => (
    <div data-testid="grid" data-layout={JSON.stringify(layout ?? null)}>
      {children}
    </div>
  ),
  verticalCompactor: () => [],
  noCompactor: () => [],
}));

/** What the builder writes: `BuilderWidget[]` under `config.widgets`. */
const SAVED_WIDGETS = [
  {
    id: "w-counter",
    type: "counter",
    config: { title: "Open work", metric: "total" },
    layout: { x: 0, y: 0, w: 3, h: 2 },
  },
  {
    id: "w-text",
    type: "text-block",
    config: { title: "Release note", content: "Ship payments by Friday" },
    layout: { x: 3, y: 0, w: 6, h: 3 },
  },
  {
    // Deliberately NOT implemented. A widget type the builder can save but the
    // board cannot draw must say so by name — a blank tile reads as a broken
    // board, and a crash takes the whole dashboard with it.
    id: "w-pie",
    type: "pie-chart",
    config: { title: "A pie" },
    layout: { x: 0, y: 2, w: 4, h: 4 },
  },
];

const mkBoard = (config: Record<string, unknown>) => ({
  id: "b1",
  name: "Sprint Health",
  type: "DASHBOARD",
  config,
  columns: [
    { id: "c1", key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
    { id: "c2", key: "done", name: "Done", category: "DONE", sortOrder: 1 },
  ],
});

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

// Five items, so the `total` counter must read exactly 5 — a number that is
// wrong (and visibly so) if the widget renders a placeholder or the project's
// unfiltered count.
const ITEMS = [
  mkItem({ id: "1", ticketNumber: 1, title: "Payment retries" }),
  mkItem({ id: "2", ticketNumber: 2, title: "Payment webhooks" }),
  mkItem({ id: "3", ticketNumber: 3, title: "Nav polish" }),
  mkItem({ id: "4", ticketNumber: 4, title: "Nav icons", columnKey: "done" }),
  mkItem({ id: "5", ticketNumber: 5, title: "Nav spacing", columnKey: "done" }),
];

function stubFetch(board: ReturnType<typeof mkBoard>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes("/interval-changes")
        ? { changes: [], truncated: false }
        : u.includes("/boards/")
        ? board
        : u.includes("/work-items") && !u.includes("work-item-types")
        ? ITEMS
        : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderBoard(config: Record<string, unknown>) {
  stubFetch(mkBoard(config));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardView orgId="o1" projectId="p1" projectKey="ACME" boardId="b1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("a board with saved widgets renders them", () => {
  it("draws each saved widget's own content, not a placeholder", async () => {
    renderBoard({ widgets: SAVED_WIDGETS });

    // The counter's configured title and the live count behind it.
    await waitFor(() =>
      expect(screen.getAllByText("Open work").length).toBeGreaterThan(0),
    );
    screen
      .getAllByTestId("widget-value-w-counter")
      .forEach((el) => expect(el).toHaveTextContent("5"));

    // The text block's content, which lives in config and nowhere else.
    expect(
      screen.getAllByText("Ship payments by Friday").length,
    ).toBeGreaterThan(0);

    // The builder paints `"{type} widget"` placeholder text on its own canvas.
    // If that string reaches the BOARD, the board is showing the builder's
    // stand-in rather than a rendered widget.
    expect(screen.queryAllByText(/^counter widget$/i)).toHaveLength(0);
    expect(screen.queryAllByText(/^text block widget$/i)).toHaveLength(0);
  });

  it("hands the grid each widget's SAVED x/y/w/h", async () => {
    renderBoard({ widgets: SAVED_WIDGETS });
    await waitFor(() =>
      expect(screen.getAllByText("Open work").length).toBeGreaterThan(0),
    );

    const raw = screen.getByTestId("grid").getAttribute("data-layout");
    expect(raw, "the grid was handed no layout at all").toBeTruthy();
    const layout = JSON.parse(raw!) as Array<Record<string, unknown>>;

    for (const w of SAVED_WIDGETS) {
      const cell = layout.find((l) => l.i === w.id);
      expect(cell, `no grid cell for ${w.id}`).toBeTruthy();
      expect({
        x: cell!.x,
        y: cell!.y,
        w: cell!.w,
        h: cell!.h,
      }).toEqual(w.layout);
    }
  });

  it("replaces the hard-coded default panels rather than stacking both", async () => {
    renderBoard({ widgets: SAVED_WIDGETS });
    await waitFor(() =>
      expect(screen.getAllByText("Open work").length).toBeGreaterThan(0),
    );
    // "Status Distribution" is a DEFAULT_LAYOUTS panel title. A board that
    // shows both its saved widgets AND the stock panels is not honouring the
    // saved layout, it is appending to it.
    expect(screen.queryAllByText("Status Distribution")).toHaveLength(0);
    expect(screen.queryAllByTestId("metric-total-items")).toHaveLength(0);
  });

  it("keeps the Sprint health tablist, so the other views stay reachable", async () => {
    // The widgets replace the CURRENT-sprint body only. Losing the tablist
    // would strand Burndown and Across-time behind a layout choice, and the
    // a11y gate anchors the dashboard scan on exactly this control.
    renderBoard({ widgets: SAVED_WIDGETS });
    await waitFor(() =>
      expect(screen.getAllByText("Open work").length).toBeGreaterThan(0),
    );
    expect(
      screen.getByRole("tablist", { name: "Sprint health view" }),
    ).toBeInTheDocument();
  });
});

describe("an unimplemented widget type", () => {
  it("renders a labelled tile naming the type, and does not crash the board", async () => {
    renderBoard({ widgets: SAVED_WIDGETS });

    // Positive control: the board rendered at all. Without it, "no crash" is
    // satisfied by a blank screen.
    await waitFor(() =>
      expect(screen.getAllByText("Open work").length).toBeGreaterThan(0),
    );

    const tiles = screen.getAllByTestId("widget-unavailable-w-pie");
    expect(tiles.length).toBeGreaterThan(0);
    tiles.forEach((t) => {
      expect(t).toHaveTextContent(/not available/i);
      // The raw type, so the message is actionable rather than decorative.
      expect(t).toHaveTextContent("pie-chart");
    });
  });

  it("names a type the widget catalogue has never heard of", async () => {
    renderBoard({
      widgets: [
        {
          id: "w-bogus",
          type: "not-a-real-widget",
          config: {},
          layout: { x: 0, y: 0, w: 4, h: 2 },
        },
      ],
    });
    await waitFor(() => {
      const tiles = screen.getAllByTestId("widget-unavailable-w-bogus");
      expect(tiles.length).toBeGreaterThan(0);
      tiles.forEach((t) => expect(t).toHaveTextContent("not-a-real-widget"));
    });
  });
});

describe("a board with NO saved widgets", () => {
  it("still renders today's default panels", async () => {
    // The fallback is load-bearing: every DASHBOARD/PORTFOLIO/PROGRAM board
    // that exists today has an empty `config.widgets`, so this IS the normal
    // case. `DEFAULT_LAYOUTS` must survive.
    renderBoard({ query: 'status = "open"' });

    await waitFor(() =>
      expect(screen.getAllByTestId("metric-total-items").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("Status Distribution").length).toBeGreaterThan(0);
    // …and none of the saved-widget machinery leaks in.
    expect(screen.queryAllByText("Open work")).toHaveLength(0);
  });

  it("falls back when `config.widgets` is not even an array", async () => {
    // The column is free-form JSON written by more than one surface, so a
    // malformed value must degrade to the default board rather than throw.
    renderBoard({ widgets: { nope: true } });
    await waitFor(() =>
      expect(screen.getAllByTestId("metric-total-items").length).toBeGreaterThan(0),
    );
  });
});
