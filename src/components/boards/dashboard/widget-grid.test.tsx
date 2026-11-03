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
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WidgetGrid } from "./widget-grid";
import { WidgetRegistry } from "@/lib/boards/widget-registry";
import { IMPLEMENTED_WIDGET_TYPES } from "./widgets/board-widgets";
import { WIDGET_DEFINITIONS } from "@/lib/boards/widget-definitions";
import type { BoardWidgetData } from "@/lib/boards/widget-data";
import type { BuilderWidget } from "@/types/models";

const DATA: BoardWidgetData = {
  metrics: { total: 7, completed: 3, inProgress: 2, overdue: 1 },
  series: {
    status: [{ name: "To Do", value: 4, color: "#6b7280" }],
    priority: [{ name: "High", value: 2, color: "#f97316" }],
    assignee: [{ name: "Ada", value: 5 }],
    type: [{ name: "Bug", value: 1 }],
  },
  burndown: [{ date: "Jan 1", ideal: 7, actual: 7 }],
  rows: [
    {
      id: "i1",
      key: "ACME-1",
      title: "Payment retries",
      status: "To Do",
      priority: "High",
      assignee: "Ada",
      dueDate: null,
    },
    {
      id: "i2",
      key: "ACME-2",
      title: "Nav polish",
      status: "Done",
      priority: "Low",
      assignee: "Unassigned",
      dueDate: null,
    },
  ],
};

const widget = (over: Partial<BuilderWidget> & { id: string }): BuilderWidget => ({
  type: "counter",
  config: {},
  layout: { x: 0, y: 0, w: 3, h: 2 },
  ...over,
});

function renderGrid(widgets: BuilderWidget[], data: BoardWidgetData = DATA) {
  return render(
    <WidgetGrid
      widgets={widgets}
      data={data}
      orgId="o1"
      projectId="p1"
      boardId="b1"
    />,
  );
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

  it("registers NOTHING for a type it cannot draw", () => {
    // The control on the assertion above: a registry that answered for
    // everything would make "unavailable" unreachable, and the fallback tile
    // dead code.
    const unimplemented = WIDGET_DEFINITIONS.map((d) => d.type).filter(
      (t) => !(IMPLEMENTED_WIDGET_TYPES as readonly string[]).includes(t),
    );
    expect(unimplemented.length).toBeGreaterThan(20);
    for (const type of unimplemented) {
      expect(WidgetRegistry.has(type), `${type} should not be drawable`).toBe(
        false,
      );
    }
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
    expect(screen.getAllByText(/Showing 1 of 2/).length).toBeGreaterThan(0);
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

describe("an undrawable type", () => {
  it("names the type both ways and renders no placeholder prose", () => {
    renderGrid([widget({ id: "g1", type: "gauge" })]);
    const tiles = screen.getAllByTestId("widget-unavailable-g1");
    expect(tiles.length).toBeGreaterThan(0);
    tiles.forEach((t) => {
      // The palette label a person recognises…
      expect(t).toHaveTextContent("Gauge");
      // …and the raw slug, which is what they would quote to ask for it.
      expect(t).toHaveTextContent("gauge");
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
    const { container } = renderGrid([
      widget({ id: "s1", type: "counter" }),
      widget({
        id: "s2",
        type: "text-block",
        config: { content: "a".repeat(400) },
        layout: { x: 4, y: 0, w: 6, h: 3 },
      }),
      widget({
        id: "s3",
        type: "table",
        layout: { x: 0, y: 4, w: 8, h: 5 },
      }),
      widget({ id: "s4", type: "list", layout: { x: 8, y: 4, w: 4, h: 4 } }),
    ]);

    const scrollers = [
      ...container.querySelectorAll<HTMLElement>(
        "[class*='overflow-auto'], [class*='overflow-y-auto'], [class*='overflow-x-auto']",
      ),
    ];
    // Positive control: a probe that found nothing would pass this silently.
    expect(scrollers.length).toBeGreaterThan(3);

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
