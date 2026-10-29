// @vitest-environment jsdom
//
// "Save as board" lives in the Issues TOOLBAR, beside "Save filter" — not in
// the results header, where it used to be.
//
// Two things were wrong with the old placement, and this file pins both:
//
//   1. it sat inside the `rows.length > 0` branch, so a filter matching
//      nothing RIGHT NOW could not be turned into a board at all — though a
//      board is a live view over the query and an empty one is valid;
//   2. it sat below the query bar in a muted count row, nowhere near the
//      control that builds the filter.
//
// Every test here renders with ZERO matching rows, which is exactly the state
// the old code showed no button in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => params,
  usePathname: () => "/acme/issues",
}));
vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
vi.mock("next/dynamic", () => ({ default: () => () => <textarea aria-label="Query" /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));

// Stand in for the dialog and record what it was handed, so the seeded name is
// observable without driving the real form.
const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/work-items/save-as-board-dialog", () => ({
  SaveAsBoardDialog: (props: Record<string, unknown>) => {
    seen.props = props;
    return props.open ? <div data-testid="board-dialog" /> : null;
  },
}));

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
const FACETS = {
  projects: [{ id: "p1", key: "ENG", name: "Engineering", archived: false, sector: null }],
  types: [], statuses: [], statusesByProject: {}, members: [], labels: [], intervals: [], managedProjectIds: [],
};

/** Zero matching rows throughout: the state the old button vanished in. */
function serve(cqlOn = true) {
  vi.mocked(jsonFetch).mockImplementation((async (url: string) => {
    if (url.endsWith("/facets")) return FACETS;
    if (url.endsWith("/query-language")) return { enabled: cqlOn, canManage: false };
    if (url.endsWith("/cql/schema")) return SCHEMA;
    if (url.endsWith("/cql/validate")) return { valid: true, query: { v: 1, where: null }, diagnostics: [] };
    if (url.includes("/cql/suggest")) return { items: [] };
    if (url.includes("/search")) return { data: [], total: 0 };
    if (url.endsWith("/saved-views")) return [];
    return [];
  }) as never);
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>,
  );
}

const boardButton = () => screen.queryByRole("button", { name: /Save as board/i });

beforeEach(() => {
  params = new URLSearchParams();
  seen.props = null;
  can.mockImplementation(() => true);
  serve();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Issues — Save as board placement", () => {
  it("is offered even though NOTHING matches (the old header button was not)", async () => {
    renderView();
    // The empty state really is on screen — so this is the zero-row branch.
    await screen.findByText("No issues yet");
    await waitFor(() => expect(boardButton()).not.toBeNull());
  });

  it("sits in the same toolbar row as Save filter", async () => {
    renderView();
    // "Save filter" only exists once cqlOn has resolved, which is strictly
    // later than the facets that reveal the board button — so wait on the LATER
    // of the two or this races and reports a missing sibling.
    const saveFilter = await screen.findByRole("button", { name: "Save filter" });
    expect(boardButton()).not.toBeNull();
    expect(boardButton()!.parentElement).toBe(saveFilter.parentElement);
  });

  it("is offered with the legacy filter bar too (CQL off)", async () => {
    serve(false);
    renderView();
    // Wait for something only the LEGACY bar renders, so "no Save filter"
    // below cannot pass merely because cqlOn had not resolved yet.
    await screen.findByLabelText("Saved views");
    expect(boardButton()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Save filter" })).toBeNull();
    // And the CQL schema was never even asked for.
    expect(vi.mocked(jsonFetch).mock.calls.some((c) => String(c[0]).endsWith("/cql/schema"))).toBe(false);
  });

  it("opens the dialog with NO seeded name (the Saved menu seeds; the toolbar must not inherit it)", async () => {
    renderView();
    await waitFor(() => expect(boardButton()).not.toBeNull());
    await userEvent.click(boardButton()!);
    await screen.findByTestId("board-dialog");
    expect(seen.props!.defaultName).toBe("");
  });

  it("control: no board-create permission and no managed project → no button", async () => {
    can.mockImplementation(((p: unknown) => p !== Permission.BOARD_CREATE) as never);
    renderView();
    await screen.findByText("No issues yet");
    // Positive control: wait until the toolbar is fully settled (Save filter
    // is the last of these to appear), so "no board button" is a real absence
    // and not a snapshot taken too early.
    await screen.findByRole("button", { name: "Save filter" });
    expect(boardButton()).toBeNull();
  });
  // jsdom has no layout engine, so the overflow itself cannot be measured here.
  // The class IS the invariant: every control in this row is a Button, and
  // buttonVariants carries `shrink-0 whitespace-nowrap`, so without flex-wrap
  // the row overflows its container instead of reflowing — and with
  // justify-end the overflow leaves by the START edge, hiding the leftmost
  // controls. Asserting the class is narrow, and it is the thing that breaks.
  it("the toolbar row can wrap, so a sixth control cannot push the others off-screen", async () => {
    renderView();
    const saveFilter = await screen.findByRole("button", { name: "Save filter" });
    const row = saveFilter.parentElement!;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("justify-end");
    // Control: this is really the row under test — it holds both controls.
    expect(row.contains(boardButton()!)).toBe(true);
  });
});
