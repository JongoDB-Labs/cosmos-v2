// @vitest-environment jsdom
//
// The widget renderer, against the REAL react-grid-layout.
//
// `dashboard-view.widgets.test.tsx` proves the WIRING (a saved layout reaches
// the grid) with the library stubbed, which is the only way that file can run —
// jsdom reports no layout and the board's other panels need a stubbed grid
// anyway. But a stub that re-echoes the `layout` prop cannot tell a correct
// mapping from one that merely round-trips: it is checking my own stub. So this
// file hands the real GridLayout an explicit `width` (it then never measures
// the DOM) and asserts the PIXELS it draws.
//
// It also pins the three behaviours that are mine and not the library's: which
// types are drawn, what an undrawable type says, and the order of the mobile
// stack.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/ACME/boards/b1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { WidgetGrid } from "./widget-grid";
import { WidgetRegistry } from "@/lib/boards/widget-registry";
import { IMPLEMENTED_WIDGET_TYPES } from "./widgets/board-widgets";
import {
  WIDGET_DEFINITIONS,
  getWidgetDefinitions,
} from "@/lib/boards/widget-definitions";
import type { BoardWidgetData, WidgetItemRow } from "@/lib/boards/widget-data";
import type { BuilderWidget } from "@/types/models";
import { localDayKey, addDays, formatDay } from "./widgets/widget-parts";

// Dates relative to the real today, so the time widgets (which read the
// clock) see the same picture on any day the suite runs.
const TODAY = localDayKey(new Date());
const day = (offset: number) => `${addDays(TODAY, offset)}T00:00:00.000Z`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const row = (over: Partial<WidgetItemRow> & { id: string; key: string; title: string }): WidgetItemRow => ({
  status: "To Do",
  statusCategory: "TODO",
  priority: "Medium",
  assignee: "Unassigned",
  dueDate: null,
  startDate: null,
  createdAt: hoursAgo(24 * 10),
  updatedAt: hoursAgo(24 * 10),
  completedAt: null,
  typeKey: null,
  typeName: null,
  customFields: {},
  ...over,
});

const DATA: BoardWidgetData = {
  projectKey: "ACME",
  metrics: { total: 7, completed: 3, inProgress: 2, overdue: 1 },
  series: {
    status: [{ name: "To Do", value: 4, color: "#6b7280" }],
    priority: [{ name: "High", value: 2, color: "#f97316" }],
    assignee: [{ name: "Ada", value: 5 }],
    type: [{ name: "Bug", value: 1 }],
  },
  burndown: [{ date: "Jan 1", ideal: 7, actual: 7 }],
  rows: [
    row({
      id: "i1",
      key: "ACME-1",
      title: "Payment retries",
      priority: "High",
      assignee: "Ada",
      dueDate: day(3),
      startDate: day(-2),
      updatedAt: hoursAgo(1),
      typeKey: "ops.incident",
      typeName: "Incident",
      customFields: { "aec.rfi-number": "RFI-007" },
    }),
    row({
      id: "i2",
      key: "ACME-2",
      title: "Nav polish",
      status: "Done",
      statusCategory: "DONE",
      priority: "Low",
      dueDate: day(-1),
      startDate: day(-5),
      createdAt: hoursAgo(24 * 20),
      completedAt: hoursAgo(48),
      updatedAt: hoursAgo(48),
      typeKey: "story",
      typeName: "Story",
      customFields: { "aec.submittal-status": "approved" },
    }),
    row({
      id: "i3",
      key: "ACME-3",
      title: "Login timeout",
      status: "In Progress",
      statusCategory: "IN_PROGRESS",
      priority: "Critical",
      assignee: "Ada",
      dueDate: day(-2),
      createdAt: hoursAgo(24 * 5),
      updatedAt: hoursAgo(3),
      typeKey: "ops.incident",
      typeName: "Incident",
    }),
  ],
  velocity: [
    { id: "s1", name: "Sprint 1", completed: 8, committed: 10 },
    { id: "s2", name: "Sprint 2", completed: 12, committed: null },
  ],
  intervals: [
    { id: "s3", name: "Sprint 3", startDate: day(-3), endDate: day(11), status: "ACTIVE" },
  ],
};

const widget = (over: Partial<BuilderWidget> & { id: string }): BuilderWidget => ({
  type: "counter",
  config: {},
  layout: { x: 0, y: 0, w: 3, h: 2 },
  ...over,
});

function renderGrid(widgets: BuilderWidget[], data: BoardWidgetData = DATA) {
  // A real client: the Quick Action widget opens the shared create dialog,
  // which reads through React Query like every other board control.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WidgetGrid
        widgets={widgets}
        data={data}
        orgId="o1"
        projectId="p1"
        boardId="b1"
      />
    </QueryClientProvider>,
  );
}

/** The DESKTOP copy of a widget's body (the mobile stack holds a second). */
function tile(id: string): HTMLElement {
  for (const el of screen.getAllByTestId(`widget-body-${id}`)) {
    if (el.closest(".react-grid-item")) return el;
  }
  throw new Error(`no desktop tile for ${id}`);
}

/** The grid cell react-grid-layout drew for a widget, from its inline style. */
function cellStyle(id: string): CSSStyleDeclaration {
  const body = screen.getAllByTestId(`widget-body-${id}`);
  // Two copies exist (the mobile stack and the desktop grid, one hidden by
  // CSS). The grid's tile is the one whose ancestor carries a positioning
  // style, which is what the library writes.
  for (const el of body) {
    const tile = el.closest(".react-grid-item") as HTMLElement | null;
    if (tile) return tile.style as unknown as CSSStyleDeclaration;
  }
  throw new Error(`no react-grid-item ancestor for ${id} — did the grid render?`);
}

afterEach(cleanup);

describe("the registry is actually populated", () => {
  it("has a component for every implemented type", () => {
    // The registry had zero references outside its own file. Importing the
    // renderer must be enough to fill it — if registration were a module side
    // effect a bundler could drop, this is the assertion that would go red.
    for (const type of IMPLEMENTED_WIDGET_TYPES) {
      const reg = WidgetRegistry.get(type);
      expect(reg, `nothing registered for "${type}"`).toBeTruthy();
      expect(typeof reg!.Component).toBe("function");
    }
  });

  it("draws every type the palette offers, and the rest are retired with a reason", () => {
    // Every catalogue type is either drawn or retired — no third state where
    // the palette offers a tile that then says "not available".
    const implemented = new Set<string>(IMPLEMENTED_WIDGET_TYPES);
    const neither = WIDGET_DEFINITIONS.filter(
      (d) => !implemented.has(d.type) && !d.retired,
    ).map((d) => d.type);
    expect(neither).toEqual([]);
    expect(WIDGET_DEFINITIONS).toHaveLength(31);
    expect(implemented.size).toBe(24);
  });

  it("registers NOTHING for a retired type, and the palette does not offer one", () => {
    // The control on the first assertion above: a registry that answered for
    // everything would make the retired tile unreachable.
    const retired = WIDGET_DEFINITIONS.filter((d) => d.retired).map((d) => d.type);
    expect(retired.length).toBe(7);
    const offered = new Set(
      ["software", "aec", "ops", "manufacturing", "education", "event", "consulting", undefined]
        .flatMap((sector) => getWidgetDefinitions(sector))
        .map((d) => d.type),
    );
    for (const type of retired) {
      expect(WidgetRegistry.has(type), `${type} should not be drawable`).toBe(false);
      expect(offered.has(type), `${type} should not be in the palette`).toBe(false);
      // Each one says why, in a sentence a person can act on.
      expect(WIDGET_DEFINITIONS.find((d) => d.type === type)!.retired!.length).toBeGreaterThan(20);
    }
    // Positive control: the palette probe does see a drawable type.
    expect(offered.has("gauge")).toBe(true);
  });

  it("names every registration after its catalogue entry", () => {
    // One spelling of a widget's name. The palette reads WIDGET_DEFINITIONS, so
    // a registration that invented its own label would mean the thing you add
    // and the thing you see are differently named.
    for (const type of IMPLEMENTED_WIDGET_TYPES) {
      const def = WIDGET_DEFINITIONS.find((d) => d.type === type)!;
      expect(WidgetRegistry.get(type)!.name).toBe(def.name);
      expect(WidgetRegistry.get(type)!.category).toBe(def.category);
    }
  });
});

describe("saved positions reach the screen", () => {
  it("places each widget at the pixels its saved cell implies", () => {
    // 12 columns over width 1200 with [12, 12] margins: colWidth =
    // (1200 - 12 * 13) / 12 = 87. x=4 -> 12 + 4 * (87 + 12) = 408.
    // rowHeight 30: y=2 -> 12 + 2 * (30 + 12) = 96.
    renderGrid([
      widget({ id: "a", layout: { x: 0, y: 0, w: 3, h: 2 } }),
      widget({ id: "b", layout: { x: 4, y: 2, w: 6, h: 4 } }),
    ]);

    const a = cellStyle("a");
    const b = cellStyle("b");

    // Distinct positions, which is the thing a 1x1-at-the-origin collapse
    // would destroy — exactly how two panels reached production looking broken.
    // jsdom serialises `transform` without the space after the comma.
    expect(a.transform).not.toBe(b.transform);
    expect(a.transform).toContain("translate(12px,12px)");
    expect(b.transform).toContain("translate(408px,96px)");

    // …and distinct SIZES. w=3 -> 3 * 87 + 2 * 12 = 285; w=6 -> 6 * 87 + 5 * 12
    // = 582. h=2 -> 2 * 30 + 12 = 72; h=4 -> 4 * 30 + 3 * 12 = 156.
    expect(a.width).toBe("285px");
    expect(a.height).toBe("72px");
    expect(b.width).toBe("582px");
    expect(b.height).toBe("156px");
  });

  it("does NOT compact a deliberate vertical gap away", () => {
    // The default panels use `verticalCompactor`, which pulls everything up to
    // close gaps. Applying that here would re-flow a layout someone saved into
    // one they never chose. The two widgets below sit at y=0 and y=9 with
    // nothing between them.
    //
    // WHAT THIS DOES AND DOES NOT DISCRIMINATE, measured rather than assumed:
    // `widget-grid.tsx` protects the gap twice over — `static: true` on each
    // item and `noCompactor` on the grid — and EITHER alone is enough. So
    // swapping `noCompactor` for `verticalCompactor` leaves this green (21/21),
    // and so does dropping `static`. Only removing both fails it, together with
    // the pixel assertion above. Stated here because a mutation that passes is
    // normally the tell that a test is vacuous; this one is a property test
    // over a belt-and-braces pair, and that is the honest reading of it.
    renderGrid([
      widget({ id: "top", layout: { x: 0, y: 0, w: 3, h: 2 } }),
      widget({ id: "far", layout: { x: 0, y: 9, w: 3, h: 2 } }),
    ]);
    // y=9 -> 12 + 9 * 42 = 390. Compacted to y=2 it would be 12 + 2 * 42 = 96.
    expect(cellStyle("far").transform).toContain("translate(12px,390px)");
  });

  it("survives a layout the builder could never have written", () => {
    // `Board.config` is untyped JSON. A missing or zero dimension gets a 1x1
    // cell at the origin from react-grid-layout, so it is clamped before it
    // gets there — and the tile must still be addressable afterwards.
    renderGrid([
      widget({ id: "junk", layout: { x: -3, y: -1, w: 0, h: 0 } as never }),
    ]);
    const s = cellStyle("junk");
    expect(s.transform).toContain("translate(12px,12px)");
    expect(Number.parseInt(s.width, 10)).toBeGreaterThan(0);
    expect(Number.parseInt(s.height, 10)).toBeGreaterThan(0);
  });
});

describe("what each implemented widget draws", () => {
  it("counter reads the metric it was configured with", () => {
    renderGrid([
      widget({ id: "c1", type: "counter", config: { metric: "overdue" } }),
    ]);
    screen
      .getAllByTestId("widget-value-c1")
      .forEach((el) => expect(el).toHaveTextContent("1"));
  });

  it("counter defaults to the total rather than blanking on a bad metric name", () => {
    renderGrid([
      widget({ id: "c2", type: "counter", config: { metric: "nonsense" } }),
    ]);
    screen
      .getAllByTestId("widget-value-c2")
      .forEach((el) => expect(el).toHaveTextContent("7"));
  });

  it("kpi-card reports the delta against its target without judging it", () => {
    renderGrid([
      widget({
        id: "k1",
        type: "kpi-card",
        config: { metric: "completed", target: 5 },
      }),
    ]);
    // 3 completed against a target of 5.
    expect(screen.getAllByText(/-2 vs target 5/).length).toBeGreaterThan(0);
  });

  it("kpi-card says it has no target rather than inventing one", () => {
    renderGrid([
      widget({ id: "k2", type: "kpi-card", config: { metric: "completed" } }),
    ]);
    expect(screen.getAllByText("No target set").length).toBeGreaterThan(0);
  });

  it("table renders one row per item, capped by maxItems", () => {
    renderGrid([
      widget({
        id: "t1",
        type: "table",
        config: { maxItems: 1 },
        layout: { x: 0, y: 0, w: 8, h: 5 },
      }),
    ]);
    // Scoped to the desktop tile so the mobile copy cannot double the count.
    const tables = screen.getAllByRole("table");
    const rows = tables[0].querySelectorAll("tbody tr");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("ACME-1");
    expect(screen.getAllByText(/Showing 1 of 3/).length).toBeGreaterThan(0);
  });

  it("table shows a due date as a day, not as the stored timestamp", () => {
    renderGrid([
      widget({ id: "t3", type: "table", layout: { x: 0, y: 0, w: 8, h: 5 } }),
    ]);
    const table = screen.getAllByRole("table")[0];
    const first = table.querySelector("tbody tr")!;
    expect(first.textContent).toContain("ACME-1");
    // Positive control: the row really has a due date, three days out.
    expect(first.textContent).toContain(formatDay(addDays(TODAY, 3)));
    expect(table.textContent).not.toMatch(/T00:00/);
  });

  it("table ignores column names this product has no field for", () => {
    // An AEC skin's preset asks for `ballInCourt`. Honouring it literally would
    // leave a table with zero columns, which looks like a load failure.
    renderGrid([
      widget({
        id: "t2",
        type: "table",
        config: { columns: ["ballInCourt", "specSection"] },
        layout: { x: 0, y: 0, w: 8, h: 5 },
      }),
    ]);
    expect(
      screen.getAllByRole("columnheader", { name: "Title" }).length,
    ).toBeGreaterThan(0);
  });

  it("list renders real list items", () => {
    renderGrid([
      widget({ id: "l1", type: "list", layout: { x: 0, y: 0, w: 4, h: 4 } }),
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.textContent).join(" ")).toContain("Nav polish");
  });

  it("text-block shows its content as text", () => {
    renderGrid([
      widget({
        id: "x1",
        type: "text-block",
        config: { content: "Freeze is Friday" },
      }),
    ]);
    expect(screen.getAllByText("Freeze is Friday").length).toBeGreaterThan(0);
  });

  it("text-block does not render its content as markup", () => {
    renderGrid([
      widget({
        id: "x2",
        type: "text-block",
        config: { content: "<img src=x onerror=alert(1)>" },
      }),
    ]);
    // The literal text is on screen and no element was created from it.
    expect(
      screen.getAllByText("<img src=x onerror=alert(1)>").length,
    ).toBeGreaterThan(0);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("bar-chart says which grouping it is showing", () => {
    renderGrid([
      widget({
        id: "bc",
        type: "bar-chart",
        config: { groupBy: "assignee" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      }),
    ]);
    expect(screen.getAllByText("By assignee").length).toBeGreaterThan(0);
  });

  it("line-chart names the series it draws", () => {
    renderGrid([
      widget({
        id: "lc",
        type: "line-chart",
        layout: { x: 0, y: 0, w: 6, h: 4 },
      }),
    ]);
    expect(screen.getAllByText("Interval burndown").length).toBeGreaterThan(0);
  });
});

describe("a type nothing draws", () => {
  it("a retired type says it was removed, and why", () => {
    renderGrid([widget({ id: "g1", type: "embed-iframe" })]);
    const tiles = screen.getAllByTestId("widget-unavailable-g1");
    expect(tiles.length).toBeGreaterThan(0);
    tiles.forEach((t) => {
      // The palette label a person recognises…
      expect(t).toHaveTextContent("Embed / iFrame was removed from the widget picker");
      // …and the reason, so a board saved before the retirement explains
      // itself rather than looking broken.
      expect(t).toHaveTextContent(/Link List/);
    });
  });

  it("an unknown type names itself both ways", () => {
    renderGrid([widget({ id: "u1", type: "from-a-newer-build" })]);
    const tiles = screen.getAllByTestId("widget-unavailable-u1");
    expect(tiles.length).toBeGreaterThan(0);
    tiles.forEach((t) => {
      expect(t).toHaveTextContent("from-a-newer-build");
      expect(t).toHaveTextContent(/not available/i);
    });
  });

  it("does not take its neighbours down with it", () => {
    renderGrid([
      widget({ id: "ok", type: "counter", config: { metric: "total" } }),
      widget({ id: "bad", type: "embed-iframe", layout: { x: 4, y: 0, w: 6, h: 5 } }),
    ]);
    screen
      .getAllByTestId("widget-value-ok")
      .forEach((el) => expect(el).toHaveTextContent("7"));
    expect(screen.getAllByTestId("widget-unavailable-bad").length).toBeGreaterThan(0);
  });
});

describe("the widgets that used to say 'not available'", () => {
  const big = { x: 0, y: 0, w: 8, h: 8 };

  it("gauge shows the configured share of the board's items", () => {
    renderGrid([widget({ id: "ga", type: "gauge", config: { metric: "completed" }, layout: big })]);
    // 3 completed of 7.
    expect(within(tile("ga")).getByRole("img", { name: "Completed: 43% (3 of 7)" })).toBeTruthy();
    expect(within(tile("ga")).getByTestId("widget-value-ga")).toHaveTextContent("43%");
  });

  it("gauge draws its value arc AFTER its track, so the arc is on top", () => {
    renderGrid([widget({ id: "gb", type: "gauge", config: { metric: "overdue" }, layout: big })]);
    const paths = [...tile("gb").querySelectorAll("svg path")];
    expect(paths).toHaveLength(2);
    // SVG paints in document order: the value arc must be the later sibling.
    expect(paths[1].getAttribute("data-testid")).toBe("gauge-value-arc");
    expect(within(tile("gb")).getByTestId("widget-value-gb")).toHaveTextContent("14%");
  });

  it("area-chart says what it draws and over how long", () => {
    renderGrid([widget({ id: "ar", type: "area-chart", config: { days: 14 }, layout: big })]);
    expect(within(tile("ar")).getByText("Created and completed, last 14 days")).toBeTruthy();
  });

  it("pie-chart says which grouping it is showing", () => {
    renderGrid([widget({ id: "pi", type: "pie-chart", config: { groupBy: "priority" }, layout: big })]);
    expect(within(tile("pi")).getByText("By priority")).toBeTruthy();
  });

  it("grouped-list groups the items, most urgent priority first", () => {
    renderGrid([widget({ id: "gl", type: "grouped-list", config: { groupBy: "priority" }, layout: big })]);
    const summaries = [...tile("gl").querySelectorAll("summary")].map((s) => s.textContent);
    expect(summaries).toEqual(["Critical (1)", "High (1)", "Low (1)"]);
  });

  it("checklist ticks done items, lists open ones first and counts them", () => {
    renderGrid([widget({ id: "ck", type: "checklist", layout: big })]);
    const bar = within(tile("ck")).getByRole("progressbar", { name: "Items done" });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("3");
    const items = within(tile("ck")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Open:ACME-1Payment retries",
      "Open:ACME-3Login timeout",
      "Done:ACME-2Nav polish",
    ]);
  });

  it("activity-feed lists the most recently updated first", () => {
    renderGrid([widget({ id: "af", type: "activity-feed", layout: big })]);
    const keys = within(tile("af"))
      .getAllByRole("listitem")
      .map((li) => li.textContent?.match(/ACME-\d/)?.[0]);
    expect(keys).toEqual(["ACME-1", "ACME-3", "ACME-2"]);
  });

  it("deadline-list lists open dated work, overdue first, and leaves done work out", () => {
    renderGrid([widget({ id: "dl", type: "deadline-list", layout: big })]);
    const items = within(tile("dl")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("ACME-3");
    expect(items[0]).toContain("2d overdue");
    expect(items[1]).toContain("ACME-1");
    expect(items[1]).toContain("in 3d");
  });

  it("calendar-widget marks each due item on its day and pages by month", () => {
    renderGrid([widget({ id: "ca", type: "calendar-widget", layout: big })]);
    const t = tile("ca");
    const dueKey = addDays(TODAY, 3);
    // ACME-1 is due in three days, which may fall in next month.
    let cell = t.querySelector(`td[data-day="${dueKey}"]`);
    if (!cell) {
      fireEvent.click(within(t).getByRole("button", { name: "Next month" }));
      cell = t.querySelector(`td[data-day="${dueKey}"]`);
    }
    expect(cell, "no cell for the due day").toBeTruthy();
    expect(cell!.textContent).toContain("ACME-1");

    const heading = within(t).getByRole("table").querySelector("caption")!.textContent;
    fireEvent.click(within(t).getByRole("button", { name: "Previous month" }));
    expect(within(t).getByRole("table").querySelector("caption")!.textContent).not.toBe(heading);
  });

  it("timeline-widget draws the sprint and each due date in the window", () => {
    renderGrid([widget({ id: "tl", type: "timeline-widget", layout: big })]);
    const t = tile("tl");
    expect(within(t).getByText("Sprint 3")).toBeTruthy();
    const marks = within(within(t).getByRole("list", { name: "Due dates" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent?.match(/ACME-\d/)?.[0])
      .sort();
    expect(marks).toEqual(["ACME-1", "ACME-2", "ACME-3"]);
  });

  it("gantt draws only items with both dates, and says how many it left out", () => {
    renderGrid([widget({ id: "gt", type: "gantt", layout: big })]);
    const t = tile("gt");
    const bars = within(within(t).getByRole("list", { name: "Scheduled work items" })).getAllByRole(
      "listitem",
    );
    expect(bars.map((b) => b.textContent?.match(/ACME-\d/)?.[0])).toEqual(["ACME-2", "ACME-1"]);
    expect(t.textContent).toContain("1 without both dates not shown");
  });

  it("link-list keeps http(s) and in-app links and drops a script URL", () => {
    renderGrid([
      widget({
        id: "ll",
        type: "link-list",
        config: {
          links: "Docs|https://example.com/docs\nEvil|javascript:alert(1)\nBacklog|/acme/projects/ACME",
        },
        layout: big,
      }),
    ]);
    const links = within(tile("ll")).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Docs(opens in a new tab)", "Backlog"]);
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1].getAttribute("href")).toBe("/acme/projects/ACME");
    expect(tile("ll").innerHTML).not.toContain("javascript:");
  });

  it("quick-action is a real button that opens the New work item form", () => {
    renderGrid([widget({ id: "qa", type: "quick-action", config: { label: "Log a bug" }, layout: big })]);
    expect(within(tile("qa")).getByRole("button", { name: /Log a bug/ })).toBeTruthy();
  });

  it("software.burndown draws the active sprint's burndown", () => {
    renderGrid([widget({ id: "sb", type: "software.burndown", layout: big })]);
    expect(within(tile("sb")).getByText("Interval burndown")).toBeTruthy();
  });

  it("software.velocity says what it reads, and says so when there is nothing", () => {
    renderGrid([widget({ id: "sv", type: "software.velocity", layout: big })]);
    expect(within(tile("sv")).getByText("Story points per finished sprint, as recorded at close")).toBeTruthy();
    cleanup();
    renderGrid([widget({ id: "sv2", type: "software.velocity", layout: big })], { ...DATA, velocity: [] });
    expect(within(tile("sv2")).getByText("No finished sprints with a recorded velocity yet")).toBeTruthy();
  });

  it("aec.rfi-tracker lists only items carrying an RFI number", () => {
    renderGrid([widget({ id: "rf", type: "aec.rfi-tracker", layout: big })]);
    const rows = [...tile("rf").querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("RFI-007");
    expect(rows[0]).toContain("Payment retries");
  });

  it("aec.submittal-log lists only items carrying a submittal status", () => {
    renderGrid([widget({ id: "sl", type: "aec.submittal-log", layout: big })]);
    const rows = [...tile("sl").querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("ACME-2");
    expect(rows[0]).toContain("Approved");
  });

  it("ops.incident-summary groups OPEN incidents by priority", () => {
    renderGrid([widget({ id: "is", type: "ops.incident-summary", layout: big })]);
    const t = tile("is");
    expect(t.textContent).toContain("2 open of 2, by priority");
    expect([...t.querySelectorAll("summary")].map((s) => s.textContent)).toEqual([
      "Critical (1)",
      "High (1)",
    ]);
    // ACME-2 is a story, not an incident.
    expect(t.textContent).not.toContain("ACME-2");
  });

  it("each sector register says so when nothing on the board qualifies", () => {
    const bare = { ...DATA, rows: DATA.rows.map((r) => ({ ...r, typeKey: null, customFields: {} })) };
    renderGrid(
      [
        widget({ id: "e1", type: "aec.rfi-tracker", layout: { x: 0, y: 0, w: 4, h: 4 } }),
        widget({ id: "e2", type: "aec.submittal-log", layout: { x: 4, y: 0, w: 4, h: 4 } }),
        widget({ id: "e3", type: "ops.incident-summary", layout: { x: 8, y: 0, w: 4, h: 4 } }),
      ],
      bare,
    );
    expect(tile("e1").textContent).toBe("No work items on this board have an RFI number");
    expect(tile("e2").textContent).toBe("No work items on this board have a submittal status");
    expect(tile("e3").textContent).toBe("No incident work items on this board");
  });
});

describe("keyboard reach into the scroll regions", () => {
  it("leaves no scrollable box that a keyboard cannot reach", () => {
    // axe's `scrollable-region-focusable` is SERIOUS and this gate cannot see
    // it: `e2e/a11y.spec.ts` scans the gallery's dashboard board, and no seeded
    // board has saved widgets, so the widget grid is never in a real scan.
    // (The same blindness let an empty Kanban's column strip ship failing that
    // rule — see memory: a11y-gate-scans-skeletons.) A board of counters and
    // text blocks contains nothing tabbable, so every overflow box here must be
    // focusable in its own right.
    //
    // Written as a PROPERTY over the rendered tree rather than as three
    // assertions about three divs, so a scroll region added later is caught
    // without anyone remembering to extend this.
    // One of EVERY drawable type, each in its own cell, with data.
    const { container } = renderGrid(
      IMPLEMENTED_WIDGET_TYPES.map((type, i) =>
        widget({
          id: `s${i}`,
          type,
          config:
            type === "text-block"
              ? { content: "a".repeat(400) }
              : type === "link-list"
                ? { links: "Docs|https://example.com/docs" }
                : {},
          layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 6, w: 6, h: 6 },
        }),
      ),
    );

    const scrollers = [
      ...container.querySelectorAll<HTMLElement>(
        "[class*='overflow-auto'], [class*='overflow-y-auto'], [class*='overflow-x-auto']",
      ),
    ];
    // Positive control: a probe that found nothing would pass this silently.
    expect(scrollers.length).toBeGreaterThan(10);

    for (const el of scrollers) {
      const reachable =
        el.tabIndex >= 0 ||
        el.querySelector("a[href], button, input, select, textarea, [tabindex]") !==
          null;
      expect(
        reachable,
        `a scrollable region is unreachable by keyboard: ${el.className}`,
      ).toBe(true);
    }
  });
});

describe("the tile's own chrome", () => {
  it("titles a tile with the author's title, falling back to the catalogue name", () => {
    renderGrid([
      widget({ id: "n1", type: "counter", config: { title: "Open work" } }),
      widget({ id: "n2", type: "counter", layout: { x: 4, y: 0, w: 3, h: 2 } }),
    ]);
    expect(screen.getAllByText("Open work").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Counter").length).toBeGreaterThan(0);
  });

  it("stacks the mobile copy in LAYOUT order, not insertion order", () => {
    // `config.widgets` is saved in the order tiles were added, which after a
    // few drags says nothing about where they sit. Reading the board on a phone
    // in creation order would make the two breakpoints disagree about what the
    // board says.
    const { container } = renderGrid([
      widget({ id: "bottom", config: { title: "Bottom" }, layout: { x: 0, y: 8, w: 3, h: 2 } }),
      widget({ id: "top", config: { title: "Top" }, layout: { x: 0, y: 0, w: 3, h: 2 } }),
    ]);
    const stack = container.querySelector(".md\\:hidden");
    expect(stack, "no mobile stack rendered").toBeTruthy();
    const titles = [...stack!.querySelectorAll("h3")].map((h) => h.textContent);
    expect(titles).toEqual(["Top", "Bottom"]);
  });
});
