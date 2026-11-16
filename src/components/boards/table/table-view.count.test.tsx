// @vitest-environment jsdom
//
// The Table board's "N items" counts the rows it draws. It used to count the
// items after the type filter only, so a board scoped by its query (or by the
// filter it was saved from) said "2 items" above a table of one row.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FIELDS } from "@/lib/query/fields";
import { FUNCTIONS } from "@/lib/query/functions";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { TableView } from "./table-view";

function item(id: string, title: string, priority: string) {
  return {
    id, orgId: "o1", projectId: "p1", workItemTypeId: "t1", title, description: "",
    columnKey: "todo", priority, assigneeId: null, assignees: [], parentId: null, intervalId: null,
    ticketNumber: Number(id.slice(1)), tags: [], customFields: {}, archivedAt: null,
    startDate: null, dueDate: null, completedAt: null, storyPoints: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
  };
}
const ITEMS = [item("i1", "Critical outage", "CRITICAL"), item("i2", "Polish copy", "LOW"), item("i3", "Tidy logs", "LOW")];

const SCHEMA = { version: 1, fields: FIELDS.map((f) => ({ ...f, sortable: !!f.sortable, groupable: !!f.groupable })), customFields: [], functions: FUNCTIONS };
/** `priority = CRITICAL`, as Save as board stores it. */
const CRITICAL_QUERY = { v: 1, where: { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "CRITICAL" } } };

/** Answers like the server. With `cql`, the org has the query language on and the predicate keeps CRITICAL items. */
function installFetch(config: unknown, opts: { cql?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      let body: unknown = [];
      if (url.endsWith("/boards/b1")) body = { id: "b1", name: "Table", type: "TABLE", config, columns: [] };
      else if (url.endsWith("/work-items")) body = ITEMS;
      else if (url.endsWith("/query-language")) body = { enabled: !!opts.cql, canManage: false };
      else if (url.endsWith("/cql/schema")) body = SCHEMA;
      else if (url.endsWith("/cql/validate")) body = { valid: true, diagnostics: [] };
      else if (url.endsWith("/cql/predicate")) body = { where: { priority: "CRITICAL" } };
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }),
  );
}

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TableView orgId="o1" projectId="p1" projectKey="P1" boardId="b1" />
    </QueryClientProvider>,
  );
}

/** The toolbar's count, read whole (it is several text nodes in one span). */
const countText = () =>
  [...document.querySelectorAll("span")].map((s) => s.textContent ?? "").find((t) => /^\d+( of \d+)? items$/.test(t)) ?? null;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TableView — the item count is the rows drawn", () => {
  it("a board scoped by its query counts the rows the query keeps, of all the board's items", async () => {
    installFetch({ query: CRITICAL_QUERY }, { cql: true });
    renderTable();
    expect(await screen.findByText("Critical outage")).toBeTruthy();
    // The predicate was applied: the other rows are not drawn.
    expect(screen.queryByText("Polish copy")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith("/cql/predicate"))).toBe(true);
    await waitFor(() => expect(countText()).toBe("1 of 3 items"));
  });

  it("with the query language off, the saved filter's scope is counted the same way", async () => {
    installFetch({ savedFilter: { priorities: ["CRITICAL"] } });
    renderTable();
    expect(await screen.findByText("Critical outage")).toBeTruthy();
    expect(screen.queryByText("Polish copy")).toBeNull();
    await waitFor(() => expect(countText()).toBe("1 of 3 items"));
  });

  it("an unscoped board counts everything, with no 'of'", async () => {
    installFetch({});
    renderTable();
    expect(await screen.findByText("Polish copy")).toBeTruthy();
    await waitFor(() => expect(countText()).toBe("3 items"));
  });

  it("the type filter still reads 'of' all the board's items", async () => {
    installFetch({ typeKeys: ["bug"] });
    renderTable();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith("/work-items"))).toBe(true));
    await waitFor(() => expect(countText()).toBe("0 of 3 items"));
  });
});
