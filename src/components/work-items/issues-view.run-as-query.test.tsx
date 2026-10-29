// @vitest-environment jsdom
//
// "Run as a query" has to actually run the query (FR ad579c82: "i typed
// `type == feature` and it showed nothing").
//
// The hint shipped in 2.492.1, but pressing it wrote the URL TWICE — the text
// through `onCqlChange`, then `mode=advanced` through `onModeChange` — and both
// writes were built from the same `useSearchParams` snapshot, because the bar
// has not re-rendered yet inside one event handler. So the second
// `replaceState` overwrote the first: `?mode=advanced` landed, `?cql=` did not,
// and the query the user asked to run was never run. `useCqlUrlState` names the
// hazard itself ("several params in one navigation — two replaces in a row
// race") and provides `update` for exactly this.
//
// So this drives the REAL URL: jsdom's own History, with useSearchParams read
// back off `window.location` and re-read whenever history changes, which is
// what the App Router does for a shallow update.
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

const PATH = "/acme/issues";

/** The live query string, cached per value so a re-render sees a stable snapshot. */
let cached = { search: "\u0000", value: new URLSearchParams() };
function liveParams(): URLSearchParams {
  if (cached.search !== window.location.search) {
    cached = { search: window.location.search, value: new URLSearchParams(window.location.search) };
  }
  return cached.value;
}

const urlListeners = new Set<() => void>();
function subscribeToUrl(cb: () => void): () => void {
  urlListeners.add(cb);
  return () => {
    urlListeners.delete(cb);
  };
}
// Real jsdom history, plus the notification the App Router gives React.
const nativeReplaceState = window.history.replaceState.bind(window.history);
window.history.replaceState = ((state: unknown, title: string, url?: string | URL | null) => {
  nativeReplaceState(state, title, url);
  for (const l of [...urlListeners]) l();
}) as typeof window.history.replaceState;

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => useSyncExternalStore(subscribeToUrl, liveParams, liveParams),
    usePathname: () => PATH,
  };
});
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
import { jsonFetch } from "@/lib/query/json-fetcher";
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
const SCHEMA = {
  version: 1,
  fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })),
  customFields: [],
  functions: FUNCTIONS,
};

function serve() {
  vi.mocked(jsonFetch).mockImplementation((async (url: string) => {
    if (url.endsWith("/facets")) return FACETS;
    if (url.endsWith("/query-language")) return { enabled: true, canManage: false };
    if (url.endsWith("/cql/schema")) return SCHEMA;
    if (url.endsWith("/cql/validate")) return { valid: true, diagnostics: [] };
    if (url.includes("/cql/suggest")) return { items: [] };
    if (url.includes("/search")) return { data: [], total: 0 };
    return [];
  }) as never);
}

/** The `cql=` of every search the view has asked for. */
const searchedQueries = () =>
  vi
    .mocked(jsonFetch)
    .mock.calls.map((c) => c[0] as string)
    .filter((u) => u.includes("/work-items/search"))
    .map((u) => new URLSearchParams(u.split("?")[1]).get("cql"));

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", PATH);
  window.localStorage.clear();
  serve();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("“Run as a query” on a query typed into the search box", () => {
  it("puts the query in the URL and runs it, instead of searching for the phrase", async () => {
    renderView();
    const box = await screen.findByRole("textbox", { name: "Search issues" });

    fireEvent.change(box, { target: { value: "type == feature" } });
    fireEvent.click(await screen.findByRole("button", { name: "Run as a query" }));

    // The query survives the navigation that also switches mode.
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("cql")).toBe("type == feature"),
    );
    // …and it is the query the search actually asks for.
    await waitFor(() => expect(searchedQueries()).toContain("type == feature"));
    expect(searchedQueries().some((q) => q?.startsWith("text ~"))).toBe(false);
  });

  it("switches the bar to the editor in that same navigation", async () => {
    // `?mode=basic` is how the Filters button records itself, and shared links
    // carry it — so the mode has to be written, not just preferred locally.
    window.history.replaceState(null, "", `${PATH}?mode=basic`);
    renderView();
    const box = await screen.findByRole("textbox", { name: "Search issues" });

    fireEvent.change(box, { target: { value: "status = Done" } });
    fireEvent.click(await screen.findByRole("button", { name: "Run as a query" }));

    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("cql")).toBe("status = Done");
      expect(sp.get("mode")).toBe("advanced");
    });
  });
});
