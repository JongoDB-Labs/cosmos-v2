// @vitest-environment jsdom
//
// The board's scope, its swimlanes and its actions share a row the query bar
// already draws, instead of a row of their own underneath it.
//
// The problem: a sprint board's header rows stacked and pushed the board down
// the screen, and the board's chrome used space poorly. Measured on localhost
// at 1440x900 before this change, a Kanban's first column started 97px below
// the board tabs with the query bar in Filters mode and 135px in CQL mode; one
// of the rows in each was this band's own bottom row, which held the scope
// line, "Swimlanes", "Select" and "New work item" and nothing else.
//
// That row now merges into the builder: in Filters mode into its one row,
// beside the search box; in CQL mode into the row that already holds
// "Add filter", which had the whole width to itself. Not into the editor's
// row: the editor, Run query, Format, Ask AI and help already fill it, and
// squeezing the editor would trade one crowded row for another.
//
// This renders the REAL builder, not a stub. The earlier compact test stubs it,
// which is right for what that file checks but cannot see where the builder
// puts what it is handed. jsdom computes no layout, so this asserts the DOM
// rows the layout is made of; the pixels are measured in e2e.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
}

// CodeMirror is loaded through next/dynamic; a textarea stands in for it.
vi.mock("next/dynamic", () => ({
  default: () =>
    function Editor(p: { value: string; onChange: (v: string) => void }) {
      return <textarea aria-label="Query" value={p.value} onChange={(e) => p.onChange(e.target.value)} />;
    },
}));
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn(async () => ({ items: [] })) };
});

import { BoardQueryBar } from "./board-query-bar";
import { BoardToolbarActions } from "./board-toolbar";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";
import type { CqlClientSchema } from "@/components/work-items/cql/use-cql";

const SCHEMA = {
  version: 1,
  fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })),
  customFields: [],
  functions: [...FUNCTIONS],
} as CqlClientSchema;

type Q = Parameters<typeof BoardQueryBar>[0]["q"];
const q = (over: Partial<Q> = {}): Q =>
  ({
    enabled: true,
    keep: () => true,
    pending: false,
    baselineCql: 'sprint = "Sprint 1"',
    problem: null,
    schema: SCHEMA,
    cql: "",
    setCql: () => {},
    mode: "basic",
    setMode: () => {},
    diagnostics: [],
    ...over,
  }) as unknown as Q;

/** What Kanban hands the bar: swimlanes as children, Select and New as actions. */
function renderBar(over: Partial<Q> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <BoardQueryBar
        orgId="o1"
        q={q(over)}
        actions={
          <>
            <button type="button">Select</button>
            <BoardToolbarActions>
              <button type="button">New work item</button>
            </BoardToolbarActions>
          </>
        }
      >
        <label>
          Swimlanes
          <select aria-label="Group into swimlanes" defaultValue="none">
            <option value="none">None</option>
          </select>
        </label>
      </BoardQueryBar>
    </QueryClientProvider>,
  );
  return container;
}

/** The flex row an element sits in: its nearest wrapping flex ancestor. */
const rowOf = (el: Element) => el.closest(".flex-wrap")!;

/** The band's children that take up space: everything not positioned out of the flow. */
const inFlow = (container: HTMLElement) =>
  [...container.querySelector(".border-b")!.children].filter((c) => !/\babsolute\b/.test(c.className));

/** Everything the old bottom row held. */
const movers = () => ({
  scope: screen.getByText(/This board shows/),
  swimlanes: screen.getByRole("combobox", { name: "Group into swimlanes" }),
  select: screen.getByRole("button", { name: "Select" }),
  create: screen.getByRole("button", { name: "New work item" }),
});

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});
afterEach(cleanup);

describe("the board's query bar is one row in Filters mode", () => {
  it("renders the real builder's search box (positive control)", () => {
    renderBar();
    expect(screen.getByRole("textbox", { name: "Search work items" })).toBeTruthy();
  });

  it("puts the scope, swimlanes, Select and New work item in the search box's row", () => {
    renderBar();
    const row = rowOf(screen.getByRole("textbox", { name: "Search work items" }));
    for (const [name, el] of Object.entries(movers())) {
      expect(row.contains(el), `${name} is not in the search box's row`).toBe(true);
    }
    // And it is the How-to-filter toggle's own row, not a box beside the
    // toggle: there, every wrapped line lost the toggle's column, and a board
    // with a long toolbar (Timeline) came out taller than on main.
    expect(screen.getByRole("group", { name: "How to filter" }).parentElement).toBe(row);
  });

  it("draws no second row under the builder", () => {
    const container = renderBar();
    // One child in the flow: the builder. The band used to hold the builder AND
    // a bottom row, which is the row this change removes. (The other child is
    // the pending indicator, positioned out of the flow; see below.)
    expect(inFlow(container)).toHaveLength(1);
    expect(inFlow(container)[0].contains(screen.getByRole("group", { name: "How to filter" }))).toBe(true);
  });

  it("keeps New work item last, so it is still the band's right edge", () => {
    renderBar({ cql: 'text ~ "radar"' });
    const row = rowOf(screen.getByRole("textbox", { name: "Search work items" }));
    const controls = within(row as HTMLElement).getAllByRole("button");
    expect(controls.at(-1)?.textContent).toBe("New work item");
    // Clear moved into the row too. Left beside the builder, it would sit to
    // the right of New work item, and the board's primary action would no
    // longer end the band.
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(row.contains(clear)).toBe(true);
    expect(clear.compareDocumentPosition(movers().create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("in CQL mode they share the Add filter row, not the editor's", () => {
  const cql = { mode: "advanced" as const, cql: "priority = HIGH" };

  it("puts the scope, swimlanes, Select and New work item beside Add filter", () => {
    renderBar(cql);
    const row = rowOf(screen.getByRole("combobox", { name: "Add filter" }).closest('[data-testid="query-chips"]')!.parentElement!);
    for (const [name, el] of Object.entries(movers())) {
      expect(row.contains(el), `${name} is not in the Add filter row`).toBe(true);
    }
  });

  it("leaves the editor's row to the editor and its own buttons", () => {
    renderBar(cql);
    const editorRow = rowOf(screen.getByRole("textbox", { name: "Query" }));
    // Positive control: this IS the editor's row.
    expect(editorRow.contains(screen.getByRole("button", { name: /Run query/ }))).toBe(true);
    for (const [name, el] of Object.entries(movers())) {
      expect(editorRow.contains(el), `${name} squeezed into the editor's row`).toBe(false);
    }
    // Clear is on the Add filter line. Held in place in the editor's row, it
    // narrowed the editor, and the query wrapped onto one more line.
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(editorRow.contains(clear)).toBe(false);
    expect(rowOf(screen.getByRole("combobox", { name: "Add filter" }).closest('[data-testid="query-chips"]')!.parentElement!).contains(clear)).toBe(true);
  });

  it("draws no second row under the builder", () => {
    const container = renderBar(cql);
    expect(inFlow(container)).toHaveLength(1);
  });
});

describe("what the merged row still does", () => {
  it("keeps a problem as an alert, in place of the scope", () => {
    renderBar({ problem: "field 'nope' is unknown" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/This board shows nothing/);
    expect(rowOf(screen.getByRole("textbox", { name: "Search work items" })).contains(alert)).toBe(true);
    expect(screen.queryByText(/This board shows [^n]/)).toBeNull();
  });

  it("keeps the pending state in a live region, without a box that moves the row", () => {
    renderBar({ pending: true });
    const live = screen.getByText("Filtering…");
    expect(live.closest('[aria-live="polite"]')).toBeTruthy();
    // In the merged row, an in-flow "Filtering…" that appears and vanishes
    // with every query would push the last control onto a new line and back,
    // moving the whole board each time. It is drawn out of the flow instead.
    expect(live.closest(".absolute")).toBeTruthy();
  });

  it("gives the scope its own width, and cuts it off only past a whole line", () => {
    const long = 'project = "COSMOS" AND assignee = me AND priority IN (HIGH, CRITICAL) ORDER BY due';
    renderBar({ baselineCql: long });
    const scope = screen.getByText(/This board shows/);
    // No fixed basis: a scope that doesn't fit beside the search box moves to
    // the next line whole (as on main), rather than being cut off early.
    expect(scope.className).not.toMatch(/\bbasis-|\bgrow\b/);
    expect(scope.className).toMatch(/\btruncate\b/);
    expect(scope.getAttribute("title")).toBe(long);
    // Nothing is cut off here (jsdom lays nothing out), so no More.
    expect(screen.queryByRole("button", { name: /this board's scope/ })).toBeNull();
  });

  it("offers the rest of a cut-off scope to keyboard and touch, not only to a mouse", async () => {
    // A ResizeObserver that reports at once, and a scope wider than its box.
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb();
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.className.includes("truncate") ? 600 : 200; } });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 200 });
    try {
      renderBar({ baselineCql: 'project = "COSMOS" AND assignee = me' });
      const more = await screen.findByRole("button", { name: "More of this board's scope" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(more);
      const less = screen.getByRole("button", { name: "Less of this board's scope" });
      expect(less.getAttribute("aria-expanded")).toBe("true");
      // Shown whole, in place.
      expect(screen.getByText(/This board shows/).className).not.toMatch(/\btruncate\b/);
      fireEvent.click(less);
      expect(screen.getByText(/This board shows/).className).toMatch(/\btruncate\b/);
    } finally {
      globalThis.ResizeObserver = RO;
      if (sw) Object.defineProperty(HTMLElement.prototype, "scrollWidth", sw);
      if (cw) Object.defineProperty(HTMLElement.prototype, "clientWidth", cw);
    }
  });

  it("holds Clear's place while there is nothing to clear, out of sight and out of reach", () => {
    renderBar();
    // Not a button anyone can find, focus or hear...
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    // ...but in the row, taking its width, so the first filter doesn't
    // re-wrap the row and move the board.
    const held = screen.getByText("Clear").closest("button")!;
    expect(held.className).toMatch(/\binvisible\b/);
    expect(held.getAttribute("aria-hidden")).toBe("true");
    expect(held.hasAttribute("inert")).toBe(true);
    expect(rowOf(screen.getByRole("textbox", { name: "Search work items" })).contains(held)).toBe(true);
  });

  it("keeps swimlanes and the actions when the schema has not arrived", () => {
    // Without a schema there is no builder. Swimlanes needs no schema any more
    // than New work item does, and used to vanish with the builder.
    renderBar({ schema: null as unknown as Q["schema"] });
    expect(screen.getByRole("combobox", { name: "Group into swimlanes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New work item" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Search work items" })).toBeNull();
  });
});
