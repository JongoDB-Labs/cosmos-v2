// @vitest-environment jsdom
//
// Reported twice: clicking a ticket link (`/issues?item=<id>`) dropped the user
// on the Issues list with no explanation. It was first assumed to be a deleted
// ticket, but the second report named a ticket that existed — so the deep link
// was broken for VALID items too.
//
// The cause was a race, not a missing row. The effect stripped the `item` param
// synchronously via router.replace, and `searchParams` is one of its
// dependencies — so the effect re-ran immediately, its cleanup set
// `cancelled = true`, and the still-in-flight fetch's result was discarded. It
// only ever worked when the fetch happened to beat the router.
//
// These lock both halves: the sheet opens for a real item, and an unopenable
// link says so instead of failing silently.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// The real router.replace is what triggered the destructive re-run. Reproduce
// that: replace() re-renders with a searchParams that no longer has `item`.
const replaceSpy = vi.fn();
let itemParam: string | null = "w1";
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: (...args: unknown[]) => {
      itemParam = null; // the param is now gone, exactly as after a real replace
      replaceSpy(...args);
    },
  }),
  useSearchParams: () => ({ get: (k: string) => (k === "item" ? itemParam : null) }),
  usePathname: () => "/acme/issues",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));
vi.mock("@/components/work-items/saved-views-picker", () => ({ SavedViewsPicker: () => null }));
vi.mock("@/components/work-items/save-as-board-dialog", () => ({ SaveAsBoardDialog: () => null }));
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));

// Stand in for the detail sheet. `open` is driven by the deep-linked ROW (the
// `item` prop is a separately-loaded full work item), so `open` is the signal
// that the deep link resolved.
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="sheet">open</div> : null,
}));

vi.mock("@/components/providers/permissions-provider", async (importActual) => {
  const actual =
    await importActual<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => true,
    }),
  };
});

vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { IssuesView } from "./issues-view";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";

const FACETS = {
  projects: [{ id: "p1", key: "ENG", name: "Engineering", archived: false }],
  types: [{ id: "t1", key: "TASK", name: "Task", icon: null, color: null }],
  statuses: [{ key: "todo", name: "To Do", category: "TODO" }],
  statusesByProject: { p1: [{ key: "todo", name: "To Do", category: "TODO" }] },
  members: [],
  labels: [],
  intervals: [],
  managedProjectIds: [],
};

const ROW = {
  id: "w1",
  ticketNumber: 46,
  ticketKey: "ENG-46",
  title: "nimpt-rest",
  columnKey: "todo",
  priority: "MEDIUM" as const,
  type: { id: "t1", key: "TASK", name: "Task", icon: null, color: null },
  project: { id: "p1", key: "ENG", name: "Engineering" },
  assignee: null,
  assignees: [],
  parent: null,
  intervalId: null,
  storyPoints: null,
  tags: [],
  startDate: null,
  dueDate: null,
  completedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

/** Resolve the row fetch only when released, so the router.replace provably
 *  lands FIRST — the exact ordering that used to lose the result. */
function deferredRow() {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  vi.mocked(jsonFetch).mockImplementation(((url: string) => {
    if (url.endsWith("/facets")) return Promise.resolve(FACETS);
    if (url.includes("/row")) return gate.then(() => ROW);
    if (url.includes("/search")) return Promise.resolve({ data: [], total: 0 });
    return Promise.resolve([]);
  }) as never);
  return () => release(null);
}

function renderView() {
  // One client, reused across rerenders — a fresh provider would remount the
  // whole tree and defeat the point of the re-render.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A FRESH element each time (same client): re-rendering the identical element
  // lets React bail out entirely, which would make the re-run this test depends
  // on never happen — and the test pass against the very bug it guards.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>
  );
  const r = render(tree());
  return { ...r, again: () => r.rerender(tree()) };
}

beforeEach(() => {
  itemParam = "w1";
  replaceSpy.mockClear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IssuesView — ?item= deep link", () => {
  it("opens the sheet even when the item param disappears mid-fetch", async () => {
    // The precise old failure: the param goes away while the row fetch is still
    // in flight, so the effect re-runs and its cleanup fires. The old code let
    // that cleanup cancel the fetch and threw the row away.
    const release = deferredRow();
    const { again } = renderView();

    // The param vanishes while the fetch is still pending.
    itemParam = null;
    again();

    release();

    expect(await screen.findByTestId("sheet")).toBeTruthy();
  });

  it("fetches the row only once, even though the effect re-runs", async () => {
    const release = deferredRow();
    renderView();
    release();
    await screen.findByTestId("sheet");
    await waitFor(() => expect(replaceSpy).toHaveBeenCalled());

    const rowCalls = vi
      .mocked(jsonFetch)
      .mock.calls.filter(([url]) => String(url).includes("/row"));
    expect(rowCalls).toHaveLength(1);
  });

  it("retries the SAME id on a second visit, rather than silently doing nothing", async () => {
    // The guard that stops the param-strip re-running the fetch used to be set
    // and never released, so a second navigation to one ticket — two mention
    // chips pointing at it, or acting on the error dialog's "try the link
    // again" — returned early: no sheet, no dialog, param never stripped.
    let calls = 0;
    vi.mocked(jsonFetch).mockImplementation(((url: string) => {
      if (url.endsWith("/facets")) return Promise.resolve(FACETS);
      if (url.includes("/row")) {
        calls += 1;
        return Promise.resolve(ROW);
      }
      if (url.includes("/search")) return Promise.resolve({ data: [], total: 0 });
      return Promise.resolve([]);
    }) as never);

    const { again } = renderView();
    await screen.findByTestId("sheet");
    expect(calls).toBe(1);

    // Same id arrives again while the view stays mounted.
    itemParam = "w1";
    again();

    await waitFor(() => expect(calls).toBe(2));
  });

  it("explains a link it cannot open instead of failing silently", async () => {
    vi.mocked(jsonFetch).mockImplementation(((url: string) => {
      if (url.endsWith("/facets")) return Promise.resolve(FACETS);
      if (url.includes("/row")) return Promise.reject(new FetchError(404, null, "Not found"));
      if (url.includes("/search")) return Promise.resolve({ data: [], total: 0 });
      return Promise.resolve([]);
    }) as never);

    renderView();

    expect(
      await screen.findByText(/no longer exists, or you don't have access/i),
    ).toBeTruthy();
  });

  it("words a denied item the same as a missing one", async () => {
    // A distinct "exists but denied" message would leak the item's existence.
    vi.mocked(jsonFetch).mockImplementation(((url: string) => {
      if (url.endsWith("/facets")) return Promise.resolve(FACETS);
      if (url.includes("/row")) return Promise.reject(new FetchError(403, null, "Forbidden"));
      if (url.includes("/search")) return Promise.resolve({ data: [], total: 0 });
      return Promise.resolve([]);
    }) as never);

    renderView();

    expect(
      await screen.findByText(/no longer exists, or you don't have access/i),
    ).toBeTruthy();
  });
});
