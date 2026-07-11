// @vitest-environment jsdom
// COSMOS-51 — "Assigned to me" quick-filter on the Table view. DataTable is
// stubbed to a flat title list so the test focuses on the one thing that
// changed: the row set handed to the table narrows to the current user when the
// toggle is pressed, and combines with the board's own type filter.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

// Stub the data table to a flat list of titles — sidesteps TanStack Table /
// base-ui internals and lets us assert directly on the filtered `data` prop.
vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({ data }: { data: Array<{ id: string; title: string }> }) => (
    <div data-testid="rows">
      {data.map((d) => (
        <div key={d.id}>{d.title}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => <button type="button">New issue</button>,
}));

vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
  Permission: {
    ITEM_BULK_EDIT: "ITEM_BULK_EDIT",
    ITEM_DELETE: "ITEM_DELETE",
    ITEM_CREATE: "ITEM_CREATE",
  },
}));

const BOARD = { id: "b1", columns: [], config: {} };

const TYPE = { key: "software.task", name: "Task" };
const ITEMS = [
  {
    id: "w1",
    ticketNumber: 1,
    title: "My row",
    priority: "MEDIUM",
    columnKey: "todo",
    assigneeId: "me",
    cycleId: null,
    sortOrder: 0,
    workItemType: TYPE,
  },
  {
    id: "w2",
    ticketNumber: 2,
    title: "Their row",
    priority: "LOW",
    columnKey: "todo",
    assigneeId: "other",
    cycleId: null,
    sortOrder: 1,
    workItemType: TYPE,
  },
];

const MEMBERS = [
  { userId: "me", user: { displayName: "Me" } },
  { userId: "other", user: { displayName: "Other" } },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url === "/api/v1/me")
      return Promise.resolve({ id: "me", email: "me@x.com", displayName: "Me" });
    if (url.endsWith("/boards/b1")) return Promise.resolve(BOARD);
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/cycles")) return Promise.resolve([]);
    return Promise.resolve([]);
  }),
}));

import { TableView } from "./table-view";

const renderTable = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TableView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
};

describe("TableView — Assigned to me", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("filters rows to the current user and restores when toggled off", async () => {
    renderTable();

    await screen.findByText("My row");
    expect(screen.getByText("Their row")).toBeInTheDocument();

    const btn = await screen.findByRole("button", { name: /assigned to me/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("My row")).toBeInTheDocument();
    expect(screen.queryByText("Their row")).toBeNull();

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Their row")).toBeInTheDocument();
  });
});
