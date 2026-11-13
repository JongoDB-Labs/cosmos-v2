// Reading `Board.config.widgets`, which is untyped JSON written by four
// different surfaces (the builder, "Save as board", the TIMELINE mode seed, a
// Table's `typeKeys`). A throw in here takes the whole board down rather than
// one tile, so every reader degrades instead of asserting.
import { describe, expect, it } from "vitest";
import {
  readBuilderWidgets,
  normalizeLayout,
  byGridPosition,
  widgetMetricKey,
  widgetGroupKey,
  widgetMaxItems,
  widgetConfigNumber,
  widgetConfigText,
  WIDGET_METRICS,
  WIDGET_GROUPS,
  widgetMetricLabel,
  widgetGroupLabel,
  widgetLinks,
  widgetRatioKey,
  widgetDays,
  groupRows,
  isClosedRow,
  type WidgetItemRow,
} from "./widget-data";

const w = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  type: "counter",
  config: { title: "T" },
  layout: { x: 1, y: 2, w: 3, h: 4 },
  ...over,
});

describe("readBuilderWidgets", () => {
  it("reads a well-formed layout through unchanged", () => {
    // Positive control: every "drops X" case below is meaningless without
    // proof that the reader keeps a valid widget.
    const out = readBuilderWidgets({ widgets: [w()] });
    expect(out).toEqual([
      {
        id: "w1",
        type: "counter",
        config: { title: "T" },
        layout: { x: 1, y: 2, w: 3, h: 4 },
      },
    ]);
  });

  it("answers [] for every shape that is not a widget array", () => {
    for (const config of [
      null,
      undefined,
      {},
      "a string",
      42,
      { widgets: null },
      { widgets: "nope" },
      { widgets: { nope: true } },
      { widgets: 7 },
    ]) {
      expect(readBuilderWidgets(config), JSON.stringify(config)).toEqual([]);
    }
  });

  it("keeps the other config keys' business out of it", () => {
    // A board whose config carries only a CQL baseline has no widgets, and must
    // not be read as having one.
    expect(
      readBuilderWidgets({ query: 'status = "open"', mode: "release-timeline" }),
    ).toEqual([]);
  });

  it("drops entries with no usable id or type", () => {
    const out = readBuilderWidgets({
      widgets: [
        w({ id: undefined }),
        w({ id: "" }),
        w({ id: 7 }),
        w({ type: undefined }),
        w({ type: "" }),
        null,
        "a string",
        w({ id: "keep" }),
      ],
    });
    expect(out.map((x) => x.id)).toEqual(["keep"]);
  });

  it("drops a DUPLICATE id, keeping the first", () => {
    // Two children with the same React key: one is silently dropped from the
    // tree, so a tile would vanish with nothing to explain it.
    const out = readBuilderWidgets({
      widgets: [
        w({ id: "dup", config: { title: "first" } }),
        w({ id: "dup", config: { title: "second" } }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].config.title).toBe("first");
  });

  it("substitutes an empty config for one that is not an object", () => {
    for (const config of [null, undefined, "x", 3, ["a"]]) {
      expect(readBuilderWidgets({ widgets: [w({ config })] })[0].config).toEqual(
        {},
      );
    }
  });
});

describe("normalizeLayout", () => {
  it("leaves a sane cell alone", () => {
    expect(normalizeLayout({ x: 4, y: 7, w: 6, h: 5 })).toEqual({
      x: 4,
      y: 7,
      w: 6,
      h: 5,
    });
  });

  it("clamps a zero or negative size to something visible", () => {
    // react-grid-layout gives a 0-or-missing dimension a 1x1 cell at the
    // origin, where it collapses to an unreadable sliver under whatever else
    // landed there — how two stock panels reached production looking broken.
    expect(normalizeLayout({ x: 0, y: 0, w: 0, h: 0 })).toMatchObject({
      w: 1,
      h: 1,
    });
    expect(normalizeLayout({ x: 0, y: 0, w: -5, h: -5 })).toMatchObject({
      w: 1,
      h: 1,
    });
  });

  it("clamps a negative or off-grid position onto the grid", () => {
    expect(normalizeLayout({ x: -4, y: -9, w: 3, h: 2 })).toMatchObject({
      x: 0,
      y: 0,
    });
    // 12 columns: a wider tile is drawn off the right edge of the container.
    expect(normalizeLayout({ x: 40, y: 0, w: 99, h: 2 })).toMatchObject({
      x: 11,
      w: 12,
    });
  });

  it("supplies a whole cell when there is no layout at all", () => {
    for (const bad of [undefined, null, {}, "x", 3]) {
      const l = normalizeLayout(bad);
      expect(l.w).toBeGreaterThan(0);
      expect(l.h).toBeGreaterThan(0);
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("is idempotent, so applying it twice is safe", () => {
    // It runs in `readBuilderWidgets` AND again in `WidgetGrid`.
    const once = normalizeLayout({ x: -1, y: 3, w: 99, h: 0 });
    expect(normalizeLayout(once)).toEqual(once);
  });
});

describe("byGridPosition", () => {
  it("orders top-to-bottom, then left-to-right", () => {
    const at = (x: number, y: number) =>
      w({ id: `${x},${y}`, layout: { x, y, w: 1, h: 1 } });
    const sorted = [at(4, 2), at(0, 0), at(0, 2), at(8, 0)].sort(byGridPosition);
    expect(sorted.map((s) => s.id)).toEqual(["0,0", "8,0", "0,2", "4,2"]);
  });
});

describe("config readers", () => {
  it("accepts a known metric and rejects everything else", () => {
    for (const m of WIDGET_METRICS) {
      expect(widgetMetricKey({ metric: m.key })).toBe(m.key);
    }
    for (const bad of [undefined, null, "", "nonsense", 7, {}]) {
      expect(widgetMetricKey({ metric: bad })).toBe("total");
    }
  });

  it("accepts a known grouping and rejects everything else", () => {
    for (const g of WIDGET_GROUPS) {
      expect(widgetGroupKey({ groupBy: g.key })).toBe(g.key);
    }
    for (const bad of [undefined, "ballInCourt", 1]) {
      expect(widgetGroupKey({ groupBy: bad })).toBe("status");
    }
  });

  it("labels every metric and grouping", () => {
    // A label lookup returning undefined would render a blank caption, and the
    // records are built from the same arrays so this cannot drift silently.
    for (const m of WIDGET_METRICS) expect(widgetMetricLabel(m.key)).toBeTruthy();
    for (const g of WIDGET_GROUPS) expect(widgetGroupLabel(g.key)).toBeTruthy();
  });

  it("clamps maxItems, including the strings a number input produces", () => {
    expect(widgetMaxItems({ maxItems: 5 })).toBe(5);
    expect(widgetMaxItems({ maxItems: "12" })).toBe(12);
    expect(widgetMaxItems({ maxItems: 0 })).toBe(1);
    expect(widgetMaxItems({ maxItems: -3 })).toBe(1);
    expect(widgetMaxItems({ maxItems: 5000 })).toBe(50);
    expect(widgetMaxItems({ maxItems: 2.7 })).toBe(2);
    expect(widgetMaxItems({})).toBe(10);
    expect(widgetMaxItems({ maxItems: "abc" }, 25)).toBe(25);
  });

  it("tells a missing number from a zero", () => {
    // A KPI with target 0 is a real target; a KPI with no target must not be
    // compared against an invented one.
    expect(widgetConfigNumber({ target: 0 }, "target")).toBe(0);
    expect(widgetConfigNumber({ target: "0" }, "target")).toBe(0);
    expect(widgetConfigNumber({}, "target")).toBeNull();
    expect(widgetConfigNumber({ target: null }, "target")).toBeNull();
    expect(widgetConfigNumber({ target: "" }, "target")).toBeNull();
    expect(widgetConfigNumber({ target: "abc" }, "target")).toBeNull();
  });

  it("treats whitespace-only text as absent", () => {
    expect(widgetConfigText({ title: "Open work" }, "title", "x")).toBe(
      "Open work",
    );
    expect(widgetConfigText({ title: "   " }, "title", "x")).toBe("x");
    expect(widgetConfigText({ title: "" }, "title", "x")).toBe("x");
    expect(widgetConfigText({}, "title", "x")).toBe("x");
    expect(widgetConfigText({ title: 7 }, "title", "x")).toBe("x");
  });
});

describe("widgetLinks", () => {
  it("reads Label|URL lines, and a bare URL as its own label", () => {
    expect(
      widgetLinks({
        links: "Docs|https://example.com/docs\n\nhttps://example.com/x\n  Board | /acme/projects  ",
      }),
    ).toEqual([
      { label: "Docs", href: "https://example.com/docs", external: true },
      { label: "https://example.com/x", href: "https://example.com/x", external: true },
      { label: "Board", href: "/acme/projects", external: false },
    ]);
  });

  it("drops every URL that is not http(s) or an in-app path", () => {
    // Free text one person types onto a board everyone opens: a script URL
    // would run in each viewer's session on click.
    const links = widgetLinks({
      links: [
        "A|javascript:alert(1)",
        "B|JavaScript:alert(1)",
        "C|data:text/html,<script>alert(1)</script>",
        "D|vbscript:x",
        "E|//evil.example.com/path",
        "F|not a url",
        "G|https://example.com/ok",
      ].join("\n"),
    });
    // Positive control: the one good line survives, so the empties above are
    // the filter talking and not a parser that returns nothing.
    expect(links.map((l) => l.label)).toEqual(["G"]);
  });

  it("returns nothing for a value that is not text, and caps the list", () => {
    expect(widgetLinks({})).toEqual([]);
    expect(widgetLinks({ links: ["https://example.com"] })).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `L${i}|https://example.com/${i}`).join("\n");
    expect(widgetLinks({ links: many })).toHaveLength(50);
  });
});

describe("widgetRatioKey and widgetDays", () => {
  it("defaults an unknown share to completed", () => {
    expect(widgetRatioKey({ metric: "overdue" })).toBe("overdue");
    expect(widgetRatioKey({ metric: "total" })).toBe("completed");
    expect(widgetRatioKey({})).toBe("completed");
  });

  it("clamps the day window to 7-365", () => {
    expect(widgetDays({ days: 14 })).toBe(14);
    expect(widgetDays({ days: "60" })).toBe(60);
    expect(widgetDays({ days: 1 })).toBe(7);
    expect(widgetDays({ days: 9000 })).toBe(365);
    expect(widgetDays({ days: "x" }, 21)).toBe(21);
  });
});

describe("groupRows", () => {
  const r = (id: string, over: Partial<WidgetItemRow>): WidgetItemRow => ({
    id,
    key: id,
    title: id,
    status: "To Do",
    columnKey: "todo",
    statusCategory: "TODO",
    priority: "Medium",
    assignee: "Unassigned",
    dueDate: null,
    startDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    typeKey: null,
    typeName: null,
    customFields: {},
    ...over,
  });

  it("orders named groups first, drops empty ones, and appends the rest", () => {
    const groups = groupRows(
      [r("a", { priority: "Low" }), r("b", { priority: "Critical" }), r("c", { priority: "Weird" })],
      "priority",
      ["Critical", "High", "Medium", "Low"],
    );
    expect(groups.map((g) => [g.name, g.rows.map((x) => x.id)])).toEqual([
      ["Critical", ["b"]],
      ["Low", ["a"]],
      ["Weird", ["c"]],
    ]);
  });

  it("groups an item with no type under No type", () => {
    const groups = groupRows([r("a", { typeName: "Bug" }), r("b", {})], "type");
    expect(groups.map((g) => g.name)).toEqual(["Bug", "No type"]);
  });

  it("calls done and cancelled items closed, and nothing else", () => {
    const at = (statusCategory: string, completedAt: string | null = null) =>
      isClosedRow({ columnKey: "lane", statusCategory, completedAt });
    expect(at("DONE")).toBe(true);
    expect(at("CANCELLED")).toBe(true);
    expect(at("IN_PROGRESS")).toBe(false);
    expect(at("TODO")).toBe(false);
    // The shared rule's own signal: an item stamped complete is settled
    // whatever lane it sits in — the same answer every other strikethrough
    // gives (`isWorkItemResolved`).
    expect(at("IN_PROGRESS", "2026-11-01T00:00:00.000Z")).toBe(true);
  });
});
