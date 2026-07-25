// @vitest-environment jsdom
// COSMOS-141 — clicking an item (its key affordance) in the TABLE view opens a
// read-focused detail drawer for that item, reusing the shared IssueDetailSheet.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom ---
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
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/projects/COS/boards/b1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
// The toolbar's create button loads its own data — irrelevant to the drawer.
vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => null,
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

vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { TableView } from "./table-view";
import { jsonFetch } from "@/lib/query/json-fetcher";

const BOARD = {
  id: "b1",
  orgId: "o1",
  projectId: "p1",
  name: "Tasks",
  type: "TABLE",
  config: {},
  sortOrder: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  columns: [
    { id: "c1", boardId: "b1", name: "To Do", key: "todo", color: "#111", wipLimit: null, sortOrder: 0, category: "TODO" },
    { id: "c2", boardId: "b1", name: "In Progress", key: "in_progress", color: "#222", wipLimit: null, sortOrder: 1, category: "IN_PROGRESS" },
  ],
};

const ITEM = {
  id: "w1",
  orgId: "o1",
  projectId: "p1",
  workItemTypeId: "t1",
  title: "Wire up the widget",
  description: "",
  columnKey: "in_progress",
  assigneeId: "u1",
  priority: "HIGH",
  intervalId: null,
  parentId: null,
  ticketNumber: 7,
  storyPoints: 3,
  sortOrder: 0,
  dueDate: null,
  startDate: null,
  actualStart: null,
  completedAt: null,
  workCategory: "BUSINESS",
  tags: [],
  customFields: {},
  createdById: "u1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  workItemType: { id: "t1", key: "TASK", name: "Task", icon: null, color: null },
};

const MEMBERS = [
  {
    id: "m1",
    orgId: "o1",
    userId: "u1",
    role: "MEMBER",
    user: { id: "u1", displayName: "Ada Lovelace", avatarUrl: null, email: "ada@example.com" },
  },
];

function wire() {
  vi.mocked(jsonFetch).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/boards/b1")) return Promise.resolve(BOARD);
    if (url.includes("/work-items")) return Promise.resolve([ITEM]);
    if (url.includes("/members")) return Promise.resolve(MEMBERS);
    if (url.includes("/intervals")) return Promise.resolve([]);
    return Promise.resolve({});
  });
  // IssueDetailSheet fetches description/watch via global fetch on open.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ watching: false, description: "" }) }),
    ),
  );
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TableView orgId="o1" projectId="p1" projectKey="COS" boardId="b1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  wire();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TableView — item detail drawer (COSMOS-141)", () => {
  it("opens the detail drawer when the item's key affordance is clicked", async () => {
    renderView();

    // Row loaded — the key affordance carries an explicit open label.
    const opener = await screen.findByRole("button", { name: "Open COS-7" });

    // Drawer is closed until the affordance is clicked.
    expect(screen.queryByTestId("issue-detail-body")).not.toBeInTheDocument();

    fireEvent.click(opener);

    // The drawer renders the item's detail, scoped to this row.
    const body = await screen.findByTestId("issue-detail-body");
    expect(body).toBeInTheDocument();
    // Sheet header shows the composed ticket key and resolved assignee.
    expect(within(body).getByText("Ada Lovelace")).toBeInTheDocument();
  });
});
