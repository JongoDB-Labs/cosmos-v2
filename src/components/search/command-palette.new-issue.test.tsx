// @vitest-environment jsdom
//
// COSMOS-166 — "Ctrl+K New Issue (via anywhere)".
//
// Reported from the Gantt: pressing ⌘K / Ctrl+K there gave a search box and a
// cut-down capture form, and in fullscreen the toolbar's "New issue" button is
// gone entirely, so the keyboard was a dead end for the one thing the reporter
// wanted from it.
//
// ASSUMPTION UNDER TEST (flagged for the reviewer): ⌘K opens the EXISTING
// command palette with a "New issue" action registered for the surface in
// scope — it does not jump straight into a form — and choosing it opens the
// standard create dialog pre-filled with the project/board in scope plus the
// dates of the row in focus.
//
// So this drives the two components together: the real Gantt publishes its
// context, the real palette reads it. Only the create dialog is stubbed, to
// keep the assertions on WHAT IT WAS HANDED rather than on its own internals.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- base-ui / cmdk need these in jsdom (see the sibling palette specs) ---
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

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({ NewIssueButton: () => null }));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

// The one stub: records the props the palette hands the standard create dialog.
vi.mock("@/components/work-items/create-work-item-dialog", () => ({
  CreateWorkItemDialog: (props: {
    open: boolean;
    prefilledProjectId?: string;
    boardId?: string;
    initialStartDate?: string | null;
    initialDueDate?: string | null;
  }) =>
    props.open ? (
      <div
        data-testid="create-issue-dialog"
        data-project={String(props.prefilledProjectId)}
        data-board={String(props.boardId)}
        data-start={String(props.initialStartDate)}
        data-due={String(props.initialDueDate)}
      />
    ) : null,
}));

const ITEMS = [
  {
    id: "i1",
    ticketNumber: 101,
    title: "Item 1",
    createdAt: "2026-01-05",
    startDate: "2026-01-05",
    dueDate: "2026-01-20",
    columnKey: "todo",
    workItemType: { key: "TASK", name: "Task" },
    priority: "MEDIUM",
    workCategory: "BUSINESS",
    parentId: null,
    children: [],
    assigneeId: null,
    assignees: [],
    actualStart: null,
    storyPoints: null,
    completedAt: null,
    highlight: null,
  },
];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string) => {
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.includes("/boards/"))
      return Promise.resolve({
        id: "b1",
        columns: [
          { key: "todo", category: "TODO" },
          { key: "done", category: "DONE" },
        ],
      });
    return Promise.resolve([]);
  }),
}));

import { CommandPalette } from "./command-palette";
import { TimelineView } from "@/components/boards/timeline/timeline-view";
import { DrawerProvider } from "@/components/drawers/drawer-provider";
import { setNewIssueContext } from "@/lib/boards/new-issue-context";

function renderApp({ timeline }: { timeline: boolean }) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DrawerProvider>
        {timeline && (
          <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
        )}
        <CommandPalette orgs={[{ id: "org-1", slug: "acme" }]} />
      </DrawerProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  // The context is a module-level slot; unmounting clears it, but reset
  // explicitly so one spec can never seed the next.
  setNewIssueContext(null);
  push.mockClear();
  vi.clearAllMocks();
});

describe("⌘K → New issue, from the Gantt (COSMOS-166)", () => {
  it("offers the action for the board in scope and opens the standard create dialog", async () => {
    renderApp({ timeline: true });
    await screen.findByTestId("gantt-bar-i1");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    const action = await screen.findByText("New issue in FSC timeline…");
    fireEvent.click(action);

    const dialog = await screen.findByTestId("create-issue-dialog");
    expect(dialog.getAttribute("data-project")).toBe("p1");
    // The board, so the dialog's Status picker uses THIS board's workflow.
    expect(dialog.getAttribute("data-board")).toBe("b1");
  });

  it("seeds the dates from the row under the pointer", async () => {
    renderApp({ timeline: true });
    fireEvent.mouseOver(await screen.findByTestId("gantt-bar-i1"));

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.click(await screen.findByText("New issue in FSC timeline…"));

    const dialog = await screen.findByTestId("create-issue-dialog");
    expect(dialog.getAttribute("data-start")).toBe("2026-01-05");
    expect(dialog.getAttribute("data-due")).toBe("2026-01-20");
  });

  it("leaves the dates empty when no row is in focus", async () => {
    renderApp({ timeline: true });
    await screen.findByTestId("gantt-bar-i1");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.click(await screen.findByText("New issue in FSC timeline…"));

    const dialog = await screen.findByTestId("create-issue-dialog");
    expect(dialog.getAttribute("data-start")).toBe("null");
    expect(dialog.getAttribute("data-due")).toBe("null");
  });

  it("shows no surface-scoped action where nothing has published one", async () => {
    renderApp({ timeline: false });

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    // The palette still opens with its ordinary actions…
    await screen.findByText(/Create work item/);
    // …but nothing claims a create scope, so no board-specific row and no dialog.
    await waitFor(() => expect(screen.queryByText(/^New issue in /)).toBeNull());
    expect(screen.queryByTestId("create-issue-dialog")).toBeNull();
  });
});
