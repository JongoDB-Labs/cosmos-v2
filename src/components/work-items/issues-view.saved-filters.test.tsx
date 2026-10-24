// @vitest-environment jsdom
//
// Saved filters on Issues (query phase 3): `?filter=<id>` runs the stored
// filter by id and shows its text; changing the text raises "Filter changed"
// (Save / Save as… / Discard); a filter with parts the viewer can't see says
// so; Clear lets go of the loaded filter; the Filters menu runs one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
vi.mock("@/components/work-items/save-as-board-dialog", () => ({ SaveAsBoardDialog: () => null }));
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
const can = vi.fn(() => true);
vi.mock("@/components/providers/permissions-provider", async (importActual) => {
  const actual = await importActual<typeof import("@/components/providers/permissions-provider")>();
  return { ...actual, usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "MEMBER", permissions: 0n, can }) };
});
vi.mock("@/lib/query/json-fetcher", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { IssuesView } from "./issues-view";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";
import { Permission } from "@/lib/rbac/permissions";

const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };
const FACETS = { projects: [{ id: "p1", key: "ENG", name: "Engineering", archived: false, sector: null }], types: [], statuses: [], statusesByProject: {}, members: [{ id: "u2", displayName: "Dana", avatarUrl: null }], labels: [], intervals: [], managedProjectIds: [] };
const F1 = "11111111-1111-4111-8111-111111111111";
const filterDto = (extra: Record<string, unknown> = {}) => ({
  id: F1, name: "My bugs", description: "", visibility: "PRIVATE", project: null, team: null, ownerId: "u1", ownerName: "Me",
  mine: true, canEdit: true, canDelete: true, editors: [], favorite: false, favoriteOrder: null, updatedAt: "2026-10-23T00:00:00Z",
  filter: {}, shared: false, cql: "priority = HIGH", partiallyRestricted: false, ...extra,
});

let detail = filterDto();
function serve() {
  vi.mocked(jsonFetch).mockImplementation((async (url: string, init?: RequestInit) => {
    if (url.endsWith("/facets")) return FACETS;
    if (url.endsWith("/cql/schema")) return SCHEMA;
    if (url.endsWith("/cql/validate")) return { valid: true, diagnostics: [] };
    if (url.includes("/cql/suggest")) return { items: [] };
    if (url.includes("/search")) return { data: [], total: 0 };
    if (url.endsWith(`/saved-views/${F1}`)) return init?.method === "PATCH" ? detail : detail;
    if (url.endsWith("/saved-views")) return init?.method === "POST" ? { ...filterDto(), id: "22222222-2222-4222-8222-222222222222", name: "New one" } : [filterDto()];
    return [];
  }) as never);
}
const searchUrls = () => vi.mocked(jsonFetch).mock.calls.map((c) => c[0] as string).filter((u) => u.includes("/work-items/search"));
const lastQs = () => new URLSearchParams((replaceSpy.mock.lastCall![0] as string).split("?")[1] ?? "");

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  params = new URLSearchParams();
  detail = filterDto();
  can.mockImplementation(() => true);
  serve();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});

describe("Issues — saved filters", () => {
  it("`?filter=<id>` runs the filter by id and shows its text", async () => {
    params = new URLSearchParams({ filter: F1 });
    renderView();
    await screen.findByRole("group", { name: "Filter: Priority" });
    await waitFor(() => expect(searchUrls().some((u) => u.includes(`filter=${F1}`))).toBe(true));
    const qs = new URLSearchParams(searchUrls().at(-1)!.split("?")[1]);
    expect(qs.get("cql")).toBeNull();
    // Unchanged: no "Filter changed" bar.
    expect(screen.queryByText("Filter changed")).toBeNull();
  });

  it("a changed query raises the bar; Save writes it, Discard drops the change", async () => {
    params = new URLSearchParams({ filter: F1, cql: "priority = LOW" });
    renderView();
    expect(await screen.findByText("Filter changed")).toBeTruthy();
    // The typed text runs, not the stored filter.
    await waitFor(() => expect(searchUrls().length).toBeGreaterThan(0));
    expect(new URLSearchParams(searchUrls().at(-1)!.split("?")[1]).get("cql")).toBe("priority = LOW");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith(`/api/v1/orgs/o1/saved-views/${F1}`, { method: "PATCH", body: JSON.stringify({ cql: "priority = LOW" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(lastQs().get("cql")).toBeNull();
    expect(lastQs().get("filter")).toBe(F1);
  });

  it("re-spacing or reordering is not a change", async () => {
    params = new URLSearchParams({ filter: F1, cql: "priority   =   HIGH" });
    renderView();
    await screen.findByRole("group", { name: "Filter: Priority" });
    // Only meaningful once the saved filter has loaded: wait for it to be in use.
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some((c) => (c[0] as string).endsWith(`/saved-views/${F1}`))).toBe(true));
    await act(async () => {});
    expect(screen.queryByText("Filter changed")).toBeNull();
  });

  it("someone else's filter can't be overwritten: Save is disabled with the reason", async () => {
    detail = filterDto({ mine: false, canEdit: false, canDelete: false });
    params = new URLSearchParams({ filter: F1, cql: "priority = LOW" });
    renderView();
    await screen.findByText("Filter changed");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toMatch(/can't edit this filter/);
  });

  it("says when parts of a filter are hidden from you", async () => {
    detail = filterDto({ mine: false, cql: 'project IN (ENG, "‹restricted›")', partiallyRestricted: true });
    params = new URLSearchParams({ filter: F1 });
    renderView();
    expect(await screen.findByText(/refer to things you can't see/)).toBeTruthy();
    // Run by id; the redacted text is never validated or sent as a query.
    await waitFor(() => expect(searchUrls().some((u) => u.includes(`filter=${F1}`))).toBe(true));
    expect(vi.mocked(jsonFetch).mock.calls.some((c) => (c[0] as string).endsWith("/cql/validate"))).toBe(false);
  });

  it("Clear lets go of the loaded filter too", async () => {
    params = new URLSearchParams({ filter: F1 });
    renderView();
    await screen.findByRole("group", { name: "Filter: Priority" });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastQs().get("filter")).toBeNull();
    expect(lastQs().get("cql")).toBeNull();
  });

  it("the Filters menu runs a filter and remembers it", async () => {
    // base-ui sets pointer-events: none on a submenu while it animates in,
    // which jsdom never finishes; the e2e spec drives the real thing.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderView();
    await screen.findByRole("button", { name: "Filters" });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    (await screen.findByRole("menuitem", { name: /My bugs/ })).focus();
    await user.keyboard("{ArrowRight}");
    const run = await screen.findByRole("menuitem", { name: "Run" });
    await waitFor(() => expect(document.activeElement).toBe(run));
    await user.keyboard("{Enter}");
    expect(lastQs().get("filter")).toBe(F1);
    expect(lastQs().get("cql")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("cosmos:issues:recent-filters") ?? "[]")).toEqual([F1]);
  });

  it("Save filter: sharing with the org needs the permission; saving loads the new filter", async () => {
    can.mockImplementation(((p: bigint) => p !== Permission.FILTER_SHARE_ORG) as never);
    params = new URLSearchParams({ cql: "priority = HIGH" });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Save filter" }));
    const org = (await screen.findByRole("radio", { name: /Everyone in the organization/ })) as HTMLInputElement;
    expect(org.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New one" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/saved-views", {
        method: "POST",
        body: JSON.stringify({ name: "New one", description: "", cql: "priority = HIGH", visibility: "PRIVATE", projectId: null, teamId: null, editorIds: [] }),
      }),
    );
    await waitFor(() => expect(lastQs().get("filter")).toBe("22222222-2222-4222-8222-222222222222"));
  });
});
