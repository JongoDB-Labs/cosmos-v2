// @vitest-environment jsdom
//
// A board on the query language: its baseline (stored query, pre-CQL saved
// filter, sprint), the user's query ANDed on, decided in the browser, with the
// server's ids for rows the browser can't decide, and never the unfiltered
// board while it waits.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => params,
  usePathname: () => "/acme/projects/ENG/boards/b1",
}));
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { boardBaseline, useBoardQuery } from "./use-board-query";
import { withoutProjectClauses } from "@/components/work-items/save-as-board-dialog";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";
import type { CqlNode } from "@/lib/query/ast";

const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };
const ROWS = [
  { id: "a", orgId: "o1", projectId: "p1", priority: "HIGH", archivedAt: null },
  { id: "b", orgId: "o1", projectId: "p1", priority: "LOW", archivedAt: null },
];

/** Answers like the server: the predicate is whatever the test sets; ids too. */
let predicate: unknown = {};
let ids: string[] = [];
function serve(cqlOn = true) {
  vi.mocked(jsonFetch).mockImplementation((async (url: string) => {
    if (url.endsWith("/query-language")) return { enabled: cqlOn, canManage: false };
    if (url.endsWith("/cql/schema")) {
      if (!cqlOn) throw new FetchError(404, { error: "Not found" }, "Not found");
      return SCHEMA;
    }
    if (url.endsWith("/cql/validate")) return { valid: true, diagnostics: [] };
    if (url.endsWith("/cql/predicate")) return { where: predicate };
    if (url.endsWith("/work-items/query")) return { ids };
    return [];
  }) as never);
}
const calls = (suffix: string) => vi.mocked(jsonFetch).mock.calls.filter(([u]) => String(u).endsWith(suffix));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const run = (config?: unknown, sprint?: { id: string; name?: string } | null) =>
  renderHook(() => useBoardQuery({ orgId: "o1", projectId: "p1", config, sprint, rows: ROWS }), { wrapper });

beforeEach(() => {
  params = new URLSearchParams();
  predicate = {};
  ids = [];
  vi.mocked(jsonFetch).mockReset();
});
afterEach(cleanup);

describe("boardBaseline", () => {
  it("is the stored query, a pre-CQL saved filter (its project list dropped), and the sprint", () => {
    const q = { v: 1, where: { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "HIGH" } } };
    expect(boardBaseline({ query: q }).query?.where).toEqual(q.where);
    const legacy = boardBaseline({ savedFilter: { priorities: ["HIGH"], projectIds: ["elsewhere"] } }).query;
    expect(JSON.stringify(legacy)).toContain("HIGH");
    expect(JSON.stringify(legacy)).not.toContain("elsewhere");
    expect(boardBaseline({}, { id: "s1", name: "Sprint 4" }).query?.where).toMatchObject({ value: { t: "ref", entity: "interval", id: "s1", label: "Sprint 4" } });
    expect(boardBaseline({}).query).toBeNull();
  });
  it("an unreadable stored query is a problem, never 'everything'", () => {
    const b = boardBaseline({ query: { v: 1, where: { op: "bogus" } } });
    expect(b.problem).toMatch(/can read/);
  });
});

describe("withoutProjectClauses (Save as board)", () => {
  it("drops top-level project clauses only", () => {
    const p: CqlNode = { op: "cmp", field: { kind: "sys", id: "project" }, cmp: "eq", value: { t: "ref", entity: "project", id: "x" } };
    const t: CqlNode = { op: "text", field: { kind: "sys", id: "summary" }, query: "radar" };
    expect(withoutProjectClauses({ v: 1, where: { op: "and", args: [p, t] } }).where).toEqual(t);
    expect(withoutProjectClauses({ v: 1, where: p }).where).toBeNull();
    const or: CqlNode = { op: "or", args: [p, t] };
    expect(withoutProjectClauses({ v: 1, where: or }).where).toEqual(or);
  });
});

describe("useBoardQuery", () => {
  it("with the query language off it is disabled and the board keeps its legacy filter", async () => {
    serve(false);
    const { result } = run();
    await waitFor(() => expect(calls("/query-language").length).toBe(1));
    expect(result.current.enabled).toBe(false);
    // Off: the schema (a 404 while off) is never asked for.
    expect(calls("/cql/schema")).toHaveLength(0);
  });

  it("no baseline and no query: every row, no predicate request", async () => {
    serve();
    const { result } = run();
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(ROWS.every((r) => result.current.keep(r))).toBe(true);
    expect(calls("/cql/predicate")).toHaveLength(0);
  });

  it("decides rows in the browser from the predicate: nothing until it arrives", async () => {
    serve();
    params = new URLSearchParams("cql=priority%20%3D%20HIGH");
    predicate = { priority: { in: ["HIGH"] } };
    const { result } = run();
    await waitFor(() => expect(result.current.enabled).toBe(true));
    // Before the predicate: nothing shows (never the unfiltered board).
    await waitFor(() => expect(result.current.keep(ROWS[0])).toBe(true));
    expect(result.current.keep(ROWS[1])).toBe(false);
    // The query sent is the user's AND the board's project.
    const body = JSON.parse(String((calls("/cql/predicate")[0][1] as RequestInit).body));
    expect(JSON.stringify(body.query)).toContain('"id":"p1"');
    expect(calls("/work-items/query")).toHaveLength(0);
  });

  it("while the predicate loads, the board shows nothing and says it's filtering", async () => {
    serve();
    const base = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) =>
      String(url).endsWith("/cql/predicate") ? new Promise(() => {}) : base(url, init)) as never);
    params = new URLSearchParams("cql=priority%20%3D%20HIGH");
    const { result } = run();
    await waitFor(() => expect(calls("/cql/predicate")).toHaveLength(1));
    expect(result.current.pending).toBe(true);
    expect(ROWS.some((r) => result.current.keep(r))).toBe(false);
  });

  it("rows the browser can't decide are settled by the server's ids, in one request", async () => {
    serve();
    params = new URLSearchParams("cql=watcher%20%3D%20me");
    predicate = { watchers: { some: { userId: "me" } } };
    ids = ["b"];
    const { result } = run();
    await waitFor(() => expect(result.current.keep(ROWS[1])).toBe(true));
    expect(result.current.keep(ROWS[0])).toBe(false);
    expect(calls("/work-items/query")).toHaveLength(1);
    expect(JSON.parse(String((calls("/work-items/query")[0][1] as RequestInit).body)).idsOnly).toBe(true);
  });

  it("a board whose saved query can't be read shows nothing and says why", async () => {
    serve();
    const { result } = run({ query: { v: 1, where: { op: "bogus" } } });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.problem).toBeTruthy();
    expect(ROWS.some((r) => result.current.keep(r))).toBe(false);
    expect(calls("/cql/predicate")).toHaveLength(0);
  });
});
