// @vitest-environment jsdom
// COSMOS-30 — quick inline field edits on the org-wide Issues list. Priority and
// assignee were already click-to-edit; STATUS was a read-only badge, so changing
// a ticket's status meant jumping to its board. This locks the new behavior:
//
//   - clicking a row's Status cell opens an inline picker (no navigation),
//   - the options are scoped to THAT item's project (a cross-project union would
//     offer lanes the item's own board doesn't have — an invalid transition the
//     work-item PUT can't reject), and
//   - picking a lane persists it via PUT { columnKey } to the item's project.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
  usePathname: () => "/acme/issues",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/hooks/use-work-item-realtime", () => ({ useWorkItemRealtime: () => {} }));

// Sibling toolbar/dialog children each load their own data and aren't relevant
// to inline status editing — stub them out so their fetches don't add noise.
vi.mock("@/components/work-items/saved-views-picker", () => ({ SavedViewsPicker: () => null }));
vi.mock("@/components/work-items/save-as-board-dialog", () => ({ SaveAsBoardDialog: () => null }));
vi.mock("@/components/work-items/create-work-item-dialog", () => ({ CreateWorkItemDialog: () => null }));
vi.mock("@/components/work-items/issue-detail-sheet", () => ({ IssueDetailSheet: () => null }));

// Grant ITEM_UPDATE (and everything else) so the inline editors render; keep the
// real `Permission` bitfield the component imports.
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

import { IssuesView } from "./issues-view";
import { jsonFetch } from "@/lib/query/json-fetcher";

const FACETS = {
  projects: [
    { id: "p1", key: "ENG", name: "Engineering", archived: false },
    { id: "p2", key: "OPS", name: "Operations", archived: false },
  ],
  types: [{ id: "t1", key: "TASK", name: "Task", icon: null, color: null }],
  statuses: [
    { key: "todo", name: "To Do", category: "TODO" },
    { key: "in_progress", name: "In Progress", category: "IN_PROGRESS" },
    { key: "done", name: "Done", category: "DONE" },
    { key: "triage", name: "Triage", category: "TODO" },
  ],
  statusesByProject: {
    p1: [
      { key: "todo", name: "To Do", category: "TODO" },
      { key: "in_progress", name: "In Progress", category: "IN_PROGRESS" },
      { key: "done", name: "Done", category: "DONE" },
    ],
    // A lane unique to the OTHER project — it must NOT appear for an ENG item.
    p2: [{ key: "triage", name: "Triage", category: "TODO" }],
  },
  members: [{ id: "u1", displayName: "Ada Lovelace", avatarUrl: null }],
  labels: [],
  intervals: [],
  managedProjectIds: [],
};

const ROW = {
  id: "w1",
  ticketNumber: 1,
  ticketKey: "ENG-1",
  title: "Wire up the widget",
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

function wire() {
  vi.mocked(jsonFetch).mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/work-items/facets")) return Promise.resolve(FACETS);
    if (url.includes("/work-items/search")) {
      return Promise.resolve({ data: [ROW], total: 1 });
    }
    // The saved-views picker (a sibling in the toolbar) loads its own list.
    if (url.includes("/saved-views")) return Promise.resolve([]);
    // The inline PUT (and any other write) resolves OK.
    return Promise.resolve({});
  });
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IssuesView orgId="o1" orgSlug="acme" />
    </QueryClientProvider>,
  );
}

/** The parsed body of the inline quick-edit PUT for w1, or null if it never fired. */
function itemPutBody() {
  const call = vi
    .mocked(jsonFetch)
    .mock.calls.find(
      ([url, init]) =>
        String(url).includes("/projects/p1/work-items/w1") &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
  if (!call) return null;
  const body = (call[1] as RequestInit).body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  wire();
});
afterEach(cleanup);

describe("IssuesView — inline status edit (COSMOS-30)", () => {
  it("opens a project-scoped status picker and persists the pick via columnKey", async () => {
    renderView();

    // Row loaded.
    await screen.findByText("ENG-1");

    // The Status cell is now an inline editor, not a plain badge.
    const trigger = screen.getByRole("button", { name: "Change status" });
    fireEvent.click(trigger);

    // Options are scoped to ENG's board: its lanes appear…
    const inProgress = await screen.findByRole("menuitem", { name: "In Progress" });
    expect(screen.getByRole("menuitem", { name: "To Do" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Done" })).toBeInTheDocument();
    // …but a lane that only exists on the OTHER project's board does not, so a
    // user can't pick an invalid transition for this item.
    expect(screen.queryByRole("menuitem", { name: "Triage" })).not.toBeInTheDocument();

    // Pick a new lane — it persists to the item's own project via columnKey.
    fireEvent.click(inProgress);

    await waitFor(() => expect(itemPutBody()).toEqual({ columnKey: "in_progress" }));
  });

  it("does not re-persist when the current status is re-selected", async () => {
    renderView();
    await screen.findByText("ENG-1");

    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    // Re-pick the lane the item is already in.
    fireEvent.click(await screen.findByRole("menuitem", { name: "To Do" }));

    // No-op: the cell short-circuits when the value is unchanged.
    await new Promise((r) => setTimeout(r, 0));
    expect(itemPutBody()).toBeNull();
  });
});

// The same inline-edit pattern (AC: "extensible to other fields such as assignee
// and priority") already applies to the Priority and Assignee cells. Status was
// the only field locked by a test; these cover the other two so a regression of
// either quick-edit is caught (COSMOS-30).
describe("IssuesView — inline priority & assignee edit (COSMOS-30)", () => {
  it("opens a priority picker and persists the pick", async () => {
    renderView();
    await screen.findByText("ENG-1");

    // The Priority cell is an inline editor, not a plain badge.
    fireEvent.click(screen.getByRole("button", { name: "Change priority" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "High" }));

    await waitFor(() => expect(itemPutBody()).toEqual({ priority: "HIGH" }));
  });

  it("does not re-persist when the current priority is re-selected", async () => {
    renderView();
    await screen.findByText("ENG-1");

    fireEvent.click(screen.getByRole("button", { name: "Change priority" }));
    // The row is already MEDIUM — re-picking it must be a no-op.
    fireEvent.click(await screen.findByRole("menuitem", { name: "Medium" }));

    await new Promise((r) => setTimeout(r, 0));
    expect(itemPutBody()).toBeNull();
  });

  it("opens an assignee picker and persists the pick via assigneeId", async () => {
    renderView();
    await screen.findByText("ENG-1");

    // The Assignee cell is editable once the org has members to pick from.
    fireEvent.click(screen.getByRole("button", { name: "Change assignee" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ada Lovelace" }));

    await waitFor(() => expect(itemPutBody()).toEqual({ assigneeId: "u1" }));
  });

  it("does not re-persist when the item is already unassigned and Unassigned is re-selected", async () => {
    renderView();
    await screen.findByText("ENG-1");

    fireEvent.click(screen.getByRole("button", { name: "Change assignee" }));
    // The row starts unassigned — re-picking "Unassigned" must be a no-op.
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unassigned" }));

    await new Promise((r) => setTimeout(r, 0));
    expect(itemPutBody()).toBeNull();
  });
});
