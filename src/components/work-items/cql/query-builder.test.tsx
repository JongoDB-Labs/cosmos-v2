// @vitest-environment jsdom
//
// The Issues query bar: the Filters chips and the search box edit the one
// query text, CQL runs what's typed, and Filters refuses (with a reason) a query
// chips can't show instead of rewriting it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

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

// CodeMirror is the editor's business (and e2e's); here CQL is a stand-in
// that exposes the same contract: value, onChange, onRun.
vi.mock("next/dynamic", () => ({
  default: () =>
    function Editor(p: { value: string; onChange: (v: string) => void; onRun: (v: string) => void }) {
      return (
        <textarea
          aria-label="Query"
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && p.onRun((e.target as HTMLTextAreaElement).value)}
        />
      );
    },
}));
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn(async () => ({ items: [] })) };
});

import { QueryBuilder } from "./query-builder";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { FIELDS } from "@/lib/query/fields";
import { lineCol } from "@/lib/query/errors";
import { parseCql } from "@/lib/query/parser";
import { typecheck } from "@/lib/query/typecheck";
import { FUNCTIONS } from "@/lib/query/functions";
import type { CqlClientSchema, QueryMode } from "./use-cql";

const SCHEMA = {
  version: 1,
  fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })),
  customFields: [],
  functions: [...FUNCTIONS],
} as CqlClientSchema;

const onCqlChange = vi.fn();
const onModeChange = vi.fn();
const onRunFilter = vi.fn();

type Extra = { savedFilters?: { id: string; name: string }[] };

function Harness({ initial, mode = null, savedFilters }: { initial: string; mode?: QueryMode | null } & Extra) {
  const [cql, setCql] = useState(initial);
  return (
    <QueryBuilder
      orgId="o1"
      schema={SCHEMA}
      cql={cql}
      onCqlChange={(t) => {
        onCqlChange(t);
        setCql(t);
      }}
      mode={mode}
      onModeChange={onModeChange}
      savedFilters={savedFilters}
      onRunFilter={savedFilters ? onRunFilter : undefined}
    />
  );
}

function renderBar(initial: string, mode: QueryMode | null = null, extra: Extra = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness initial={initial} mode={mode} {...extra} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QueryBuilder — Filters", () => {
  it("shows one chip per clause, and the free text in the search box", () => {
    renderBar('assignee = me AND priority IN (HIGH, CRITICAL) AND text ~ "login"');
    expect(screen.getByRole("button", { name: "Filters" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("group", { name: "Filter: Assignee" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Filter: Priority" })).toBeTruthy();
    // `text ~` is the box, not a chip.
    expect(screen.queryByRole("group", { name: "Filter: Text" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Search issues" }) as HTMLInputElement).value).toBe("login");
  });

  it("removing a chip prints the rest of the query", () => {
    renderBar("assignee = me AND priority IN (HIGH, CRITICAL)");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Priority" }));
    expect(onCqlChange).toHaveBeenLastCalledWith("assignee = me");
    expect(screen.queryByRole("group", { name: "Filter: Priority" })).toBeNull();
  });

  it("the search box writes `text ~` and keeps the chips and ORDER BY", () => {
    renderBar("assignee = me ORDER BY due ASC");
    const box = screen.getByRole("textbox", { name: "Search issues" });
    fireEvent.change(box, { target: { value: "login page" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onCqlChange).toHaveBeenLastCalledWith('assignee = me AND text ~ "login page" ORDER BY due ASC');
  });

  it("Match any turns the chips into an OR", () => {
    renderBar("assignee = me AND priority = HIGH");
    fireEvent.click(screen.getByRole("button", { name: "Match any" }));
    expect(onCqlChange).toHaveBeenLastCalledWith("assignee = me OR priority = HIGH");
  });

  it("changing a chip's operator rewrites only that clause", async () => {
    const user = userEvent.setup();
    renderBar("assignee = me AND priority IN (HIGH, CRITICAL)");
    const chip = screen.getByRole("group", { name: "Filter: Priority" });
    await user.click(within(chip).getByRole("combobox", { name: "Priority operator" }));
    await user.click(await screen.findByRole("option", { name: "is none of" }));
    expect(onCqlChange).toHaveBeenLastCalledWith("assignee = me AND priority NOT IN (HIGH, CRITICAL)");
  });
});

describe("QueryBuilder — Filters is refused, with a reason, when chips can't show the query", () => {
  it("disables Filters and opens CQL for OR across groups", () => {
    const text = "priority = HIGH OR (assignee = me AND due < now())";
    renderBar(text);
    const basic = screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement;
    expect(basic.disabled).toBe(true);
    expect(basic.title).toMatch(/mixes AND and OR/);
    // Points at the group, where it was written.
    expect(basic.title).toContain(`(col ${lineCol(text, text.indexOf("(")).column})`);
    expect(screen.getByRole("button", { name: "CQL" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Query" })).toBeTruthy();
  });

  it("history operators stay in CQL even when Filters was asked for", () => {
    renderBar("status WAS Done", "basic");
    expect((screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("textbox", { name: "Query" })).toBeTruthy();
  });
});

describe("QueryBuilder — CQL", () => {
  it("runs only on Run query, not per keystroke", () => {
    renderBar("assignee = me", "advanced");
    const editor = screen.getByRole("textbox", { name: "Query" });
    fireEvent.change(editor, { target: { value: "assignee = me AND priority = HIGH" } });
    expect(onCqlChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(onCqlChange).toHaveBeenLastCalledWith("assignee = me AND priority = HIGH");
  });

  it("switching to Filters remembers the choice for next time", () => {
    renderBar("assignee = me", "advanced");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(onModeChange).toHaveBeenLastCalledWith("basic");
    expect(window.localStorage.getItem("cosmos:issues:query-mode")).toBe("basic");
  });

  it("the syntax help's examples are all valid CQL, and picking one fills the editor", () => {
    renderBar("", "advanced");
    fireEvent.click(screen.getByRole("button", { name: "Syntax help" }));
    const region = screen.getByRole("region", { name: "Query syntax" });
    const examples = within(region).getAllByRole("button");
    expect(examples.length).toBeGreaterThan(4);
    for (const b of examples) {
      const q = b.querySelector("code")!.textContent!;
      const p = parseCql(q);
      expect(p.diagnostics, q).toEqual([]);
      expect(typecheck(p.query, { customFields: [] }, q, p.spans).diagnostics.filter((d) => d.severity === "error"), q).toEqual([]);
    }
    fireEvent.click(examples[0]);
    expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe(examples[0].querySelector("code")!.textContent);
  });

  it("Format tidies the draft without running it", () => {
    renderBar("", "advanced");
    const editor = screen.getByRole("textbox", { name: "Query" });
    fireEvent.change(editor, { target: { value: "assignee=me and priority in (high,critical)" } });
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect((editor as HTMLTextAreaElement).value).toBe("assignee = me AND priority IN (high, critical)");
    expect(onCqlChange).not.toHaveBeenCalled();
  });

  it("Ask AI fills the editor with the query and never runs it", async () => {
    vi.mocked(jsonFetch).mockImplementation((async (url: string) =>
      String(url).endsWith("/cql/ai") ? { cql: "assignee = me AND type = Bug", diagnostics: [] } : { items: [] }) as never);
    renderBar("assignee = me", "advanced");
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Describe the filter" }), { target: { value: "my bugs" } });
    fireEvent.click(screen.getByRole("button", { name: "Build query" }));
    expect(await screen.findByText(/Check the query in the editor, then Run query/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe("assignee = me AND type = Bug");
    const call = vi.mocked(jsonFetch).mock.calls.find(([u]) => String(u).endsWith("/cql/ai"))!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).prompt).toBe("my bugs");
    expect(onCqlChange).not.toHaveBeenCalled();
  });

  it("Ask AI says why when the assistant can't help, and leaves the draft alone", async () => {
    vi.mocked(jsonFetch).mockImplementation((async (url: string) => {
      if (String(url).endsWith("/cql/ai")) throw new FetchError(503, { error: { code: "AI_UNAVAILABLE", message: "The assistant couldn't build a query just now." } }, "x");
      return { items: [] };
    }) as never);
    renderBar("assignee = me", "advanced");
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Describe the filter" }), { target: { value: "my bugs" } });
    fireEvent.click(screen.getByRole("button", { name: "Build query" }));
    expect(await screen.findByText("The assistant couldn't build a query just now.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe("assignee = me");
  });

  it("Clear empties the query", () => {
    renderBar("assignee = me", "advanced");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onCqlChange).toHaveBeenLastCalledWith("");
  });
});

// ── FR ad579c82 ──────────────────────────────────────────────────────────────
// "i'm not sure what the difference between basic and advanced is. i should
// simply be able to add the filters from the dropdown on the right or
// search/save filters in the search bar"

/** Make "Add filter" offer a person, which commits a chip in one click. */
function offerPeople() {
  vi.mocked(jsonFetch).mockImplementation((async (url: string) =>
    String(url).includes("/cql/suggest")
      ? { items: [{ label: "me", insert: "me", kind: "function" }] }
      : { items: [] }) as never);
}

describe("QueryBuilder — adding a filter beside the CQL editor", () => {
  it("offers Add filter on a query Filters refuses, and ANDs the new clause onto it", async () => {
    const user = userEvent.setup();
    offerPeople();
    // Positive control: this is exactly the case that used to have NO filter
    // dropdown — chips refuse it, so the bar is forced into the CQL editor.
    renderBar("status WAS Done AFTER -7d", "basic");
    expect((screen.getByRole("button", { name: "Filters" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(await screen.findByRole("combobox", { name: "Add filter" }));
    await user.click(await screen.findByRole("option", { name: "Assignee: me" }));

    expect(onCqlChange).toHaveBeenLastCalledWith("status WAS Done AFTER -7d AND assignee = me");
  });

  it("does not offer a field the query already constrains", async () => {
    const user = userEvent.setup();
    offerPeople();
    renderBar("status WAS Done AFTER -7d", "basic");
    await user.click(await screen.findByRole("combobox", { name: "Add filter" }));
    // Priority is free; Status is already in the query and would make a second
    // condition on one field — which chips then refuse outright.
    expect(await screen.findByRole("option", { name: "Priority" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Status" })).toBeNull();
  });
});

describe("QueryBuilder — finding a saved filter from the search box", () => {
  const FILTERS = [
    { id: "f1", name: "My open bugs" },
    { id: "f2", name: "Release blockers" },
  ];

  it("offers a saved filter whose name matches what is typed, and runs it", () => {
    renderBar("", null, { savedFilters: FILTERS });
    const box = screen.getByRole("textbox", { name: "Search issues" });
    fireEvent.change(box, { target: { value: "open bu" } });

    const hit = screen.getByRole("button", { name: "My open bugs" });
    expect(screen.queryByRole("button", { name: "Release blockers" })).toBeNull();

    fireEvent.click(hit);
    expect(onRunFilter).toHaveBeenLastCalledWith({ id: "f1", name: "My open bugs" });
    // Offering a filter must not also run the text as a search.
    expect(onCqlChange).not.toHaveBeenCalled();
  });

  it("stays quiet for one character, and for text matching no filter", () => {
    renderBar("", null, { savedFilters: FILTERS });
    const box = screen.getByRole("textbox", { name: "Search issues" });
    fireEvent.change(box, { target: { value: "m" } });
    expect(screen.queryByRole("button", { name: "My open bugs" })).toBeNull();
    fireEvent.change(box, { target: { value: "login page" } });
    expect(screen.queryByRole("button", { name: "My open bugs" })).toBeNull();
  });

  it("offers nothing where there are no saved filters to run", () => {
    renderBar("", null);
    fireEvent.change(screen.getByRole("textbox", { name: "Search issues" }), { target: { value: "open bugs" } });
    expect(screen.queryByRole("button", { name: "My open bugs" })).toBeNull();
  });
});
