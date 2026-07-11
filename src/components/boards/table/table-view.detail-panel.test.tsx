// @vitest-environment jsdom
// COSMOS-96 — the Table board view could only inline-edit an item's name. This
// locks the new "open in a detail side panel" capability (parity with the
// Kanban card): a per-row affordance opens the shared CardDetailSheet, and an
// edit made in that sheet flows straight back into the table row (and survives
// closing the sheet).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => "/acme/projects/proj/boards/b1",
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

// The create-issue button loads its own data; it's irrelevant here.
vi.mock("@/components/boards/shared/create-issue-button", () => ({
  CreateIssueButton: () => null,
}));

// Stub the heavy detail sheet: assert the wiring (open state + item) and let the
// test drive its onUpdate/onOpenChange callbacks without pulling in the real
// sheet's data-loading providers.
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: ({
    item,
    open,
    onUpdate,
    onOpenChange,
  }: {
    item: { id: string; title: string } | null;
    open: boolean;
    onUpdate: (updated: unknown) => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open && item ? (
      <div role="dialog" aria-label="Item details">
        <p>Panel for: {item.title}</p>
        <button
          type="button"
          onClick={() => onUpdate({ ...item, title: "Renamed via panel" })}
        >
          panel-rename
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          panel-close
        </button>
      </div>
    ) : null,
}));

// Grant every permission so the table's actions render; keep the real bitfield.
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
import type { WorkItem, Board, OrgMember, Cycle } from "@/types/models";

const mockedFetch = vi.mocked(jsonFetch);

function makeItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi1",
    orgId: "o1",
    projectId: "proj",
    workItemTypeId: "wt1",
    title: "Design the dashboard",
    description: "",
    columnKey: "todo",
    assigneeId: null,
    priority: "MEDIUM",
    cycleId: null,
    parentId: null,
    ticketNumber: 1,
    storyPoints: null,
    sortOrder: 0,
    dueDate: null,
    startDate: null,
    baselineStart: null,
    baselineEnd: null,
    completedAt: null,
    workCategory: "BUSINESS",
    tags: [],
    customFields: {},
    createdById: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workItemType: { id: "wt1", key: "task", name: "Task", icon: null, color: null },
    ...over,
  };
}

const board: Board = {
  id: "b1",
  orgId: "o1",
  projectId: "proj",
  name: "Bugs",
  type: "TABLE",
  config: {},
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  columns: [
    {
      id: "c1",
      boardId: "b1",
      name: "To Do",
      key: "todo",
      color: "#888",
      wipLimit: null,
      sortOrder: 0,
      category: "TODO",
    },
    {
      id: "c2",
      boardId: "b1",
      name: "In Progress",
      key: "doing",
      color: "#38f",
      wipLimit: null,
      sortOrder: 1,
      category: "IN_PROGRESS",
    },
  ],
};

const members: OrgMember[] = [
  {
    id: "m1",
    orgId: "o1",
    userId: "u1",
    role: "ADMIN",
    user: { id: "u1", displayName: "Ada", avatarUrl: null, email: "ada@x.co" },
  },
];

const cycles: Cycle[] = [];

function wireFetch(items: WorkItem[]) {
  mockedFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/boards/b1")) return Promise.resolve(board);
    if (url.endsWith("/work-items")) return Promise.resolve(items);
    if (url.endsWith("/members")) return Promise.resolve(members);
    if (url.endsWith("/cycles")) return Promise.resolve(cycles);
    return Promise.resolve([]);
  });
}

function renderTable() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TableView orgId="o1" projectId="proj" projectKey="PROJ" boardId="b1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedFetch.mockReset();
});
afterEach(() => cleanup());

describe("TableView — open item in a detail side panel (COSMOS-96)", () => {
  it("shows an Open-details affordance on the row and opens the panel for that item", async () => {
    wireFetch([makeItem()]);
    renderTable();

    // Row renders (title cell shows the item).
    await screen.findByText("Design the dashboard");

    // The detail panel is closed initially.
    expect(screen.queryByRole("dialog", { name: "Item details" })).toBeNull();

    // A per-row affordance opens it.
    const opener = screen.getAllByRole("button", { name: "Open details" })[0];
    fireEvent.click(opener);

    const panel = await screen.findByRole("dialog", { name: "Item details" });
    expect(panel).toHaveTextContent("Panel for: Design the dashboard");
  });

  it("reflects a panel edit in the table row and keeps it after the panel closes", async () => {
    wireFetch([makeItem()]);
    renderTable();

    await screen.findByText("Design the dashboard");
    fireEvent.click(screen.getAllByRole("button", { name: "Open details" })[0]);
    await screen.findByRole("dialog", { name: "Item details" });

    // Edit emitted from the sheet (mirrors CardDetailSheet's onUpdate contract).
    fireEvent.click(screen.getByRole("button", { name: "panel-rename" }));

    // The table row updates immediately (AC: edits reflected in the row).
    await screen.findByText("Renamed via panel");

    // Closing the sheet keeps the saved change (AC: close without losing edits).
    fireEvent.click(screen.getByRole("button", { name: "panel-close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Item details" })).toBeNull(),
    );
    expect(screen.getByText("Renamed via panel")).toBeInTheDocument();
  });
});
