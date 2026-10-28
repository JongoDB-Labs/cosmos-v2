// @vitest-environment jsdom
//
// The Issues view on an org with CQL on: the query in the URL drives the
// search, the Watching / Archived toggles and the export; `?watching=1` lands
// as `watcher = me`. An org without CQL keeps the legacy filter bar, untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
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

let params = new URLSearchParams();
const replaceSpy = vi.fn((url: string) => {
  params = new URLSearchParams(url.split("?")[1] ?? "");
});
vi.mock("next/navigation", () => ({
  // The query is written with history.replaceState (below), never router.replace.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => params,
  usePathname: () => "/acme/issues",
}));
vi.spyOn(window.history, "replaceState").mockImplementation((_state, _title, url) => replaceSpy(String(url)));
vi.mock("next/dynamic", () => ({ default: () => () => <textarea aria-label="Query" /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));
vi.mock("@/components/work-items/saved-views-picker", () => ({ SavedViewsPicker: () => null }));
vi.mock("@/components/work-items/save-as-board-dialog", () => ({ SaveAsBoardDialog: () => null }));
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
vi.mock("@/components/providers/permissions-provider", async (importActual) => {
  const actual = await importActual<typeof import("@/components/providers/permissions-provider")>();
  return { ...actual, usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }) };
});
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { IssuesView } from "./issues-view";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";

const FACETS = {
  projects: [{ id: "p1", key: "ENG", name: "Engineering", archived: false, sector: null }],
  types: [],
  statuses: [],
  statusesByProject: {},
  members: [],
  labels: [],
  intervals: [],
  managedProjectIds: [],
};
const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };

function serve(cqlOn: boolean) {
  vi.mocked(jsonFetch).mockImplementation((async (url: string) => {
    if (url.endsWith("/facets")) return FACETS;
    if (url.endsWith("/query-language")) return { enabled: cqlOn, canManage: false };
    if (url.endsWith("/cql/schema")) {
      if (!cqlOn) throw new FetchError(404, { error: "Not found" }, "Not found");
      return SCHEMA;
    }
    if (url.endsWith("/cql/validate")) return { valid: true, diagnostics: [] };
    if (url.includes("/cql/suggest")) return { items: [] };
    if (url.includes("/search")) return { data: [], total: 0 };
    return [];
  }) as never);
}

const searchUrls = () =>
  vi
    .mocked(jsonFetch)
    .mock.calls.map((c) => c[0] as string)
    .filter((u) => u.includes("/work-items/search"));

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>
  );
  const r = render(tree());
  return { rerender: () => r.rerender(tree()) };
}

beforeEach(() => {
  params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IssuesView with CQL on", () => {
  it("searches with the URL's query, and only it", async () => {
    params = new URLSearchParams({ cql: "priority = HIGH" });
    serve(true);
    renderView();
    await waitFor(() => expect(searchUrls().length).toBeGreaterThan(0));
    const qs = new URLSearchParams(searchUrls()[0].split("?")[1]);
    expect(qs.get("cql")).toBe("priority = HIGH");
    expect(qs.get("tz")).toBeTruthy();
    expect([...qs.keys()].sort()).toEqual(["cql", "page", "pageSize", "tz"]);
    // Never a legacy search first: it waits for the flag.
    expect(searchUrls().every((u) => u.includes("cql="))).toBe(true);
    // The query builder replaced the facet selects; the search box survives.
    expect(await screen.findByRole("textbox", { name: "Search issues" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(screen.getByRole("group", { name: "Filter: Priority" })).toBeTruthy();
  });

  it("Watching and Archived toggle their clauses in the query", async () => {
    params = new URLSearchParams({ cql: "priority = HIGH" });
    serve(true);
    renderView();
    await screen.findByRole("group", { name: "Filter: Priority" });
    const watching = screen.getByRole("button", { name: /Watching/ });
    expect(watching.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(watching);
    expect(new URLSearchParams(replaceSpy.mock.lastCall![0].split("?")[1]).get("cql")).toBe("priority = HIGH AND watcher = me");
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    expect(new URLSearchParams(replaceSpy.mock.lastCall![0].split("?")[1]).get("cql")).toBe("priority = HIGH AND archived = true");
  });

  it("shows Watching pressed when the query has `watcher = me`", async () => {
    params = new URLSearchParams({ cql: "watcher = me" });
    serve(true);
    renderView();
    await waitFor(() => expect(screen.getByRole("button", { name: /Watching/ }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("exports the same query", async () => {
    params = new URLSearchParams({ cql: "priority = HIGH" });
    serve(true);
    renderView();
    await screen.findByRole("group", { name: "Filter: Priority" });
    const link = screen.getByRole("link", { name: /Export CSV/ });
    const qs = new URLSearchParams(link.getAttribute("href")!.split("?")[1]);
    expect(qs.get("cql")).toBe("priority = HIGH");
    expect(qs.get("page")).toBeNull();
  });

  it("`?watching=1` becomes `watcher = me`, in one navigation", async () => {
    params = new URLSearchParams({ watching: "1" });
    serve(true);
    renderView();
    await waitFor(() => expect(replaceSpy.mock.calls.some((c) => (c[0] as string).includes("cql="))).toBe(true));
    const call = replaceSpy.mock.calls.find((c) => (c[0] as string).includes("cql="))![0] as string;
    const qs = new URLSearchParams(call.split("?")[1]);
    expect(qs.get("cql")).toBe("watcher = me");
    expect(qs.get("watching")).toBeNull();
  });
});

describe("IssuesView with CQL off", () => {
  it("keeps the legacy filter bar and never sends cql=", async () => {
    serve(false);
    renderView();
    expect(await screen.findByRole("combobox", { name: "Project" })).toBeTruthy();
    await waitFor(() => expect(searchUrls().length).toBeGreaterThan(0));
    expect(searchUrls().some((u) => u.includes("cql="))).toBe(false);
    expect(screen.queryByRole("button", { name: "CQL" })).toBeNull();
  });

  it("doesn't ask for the schema at all, so the browser logs no 404", async () => {
    serve(false);
    renderView();
    await waitFor(() => expect(searchUrls().length).toBeGreaterThan(0));
    const urls = vi.mocked(jsonFetch).mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.endsWith("/query-language"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/cql/schema"))).toBe(false);
  });
});
