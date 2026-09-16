// @vitest-environment jsdom
//
// ONE rule, asserted on BOTH of the components that implement it.
//
// A work item's statuses can come from two places, and the order matters:
//
//   1. the HOST board's own columns, whenever it has any — that board's real
//      workflow, in its own order. `POST /projects` seeds these onto every board
//      type it creates, so on a template-created project Table, Calendar, RAID
//      and Dashboard are already correct;
//   2. otherwise the project-wide union across the project's boards — the
//      fallback for a board added later through `POST /boards`, which seeds
//      columns only for the two ceremony types and so leaves everything else
//      with none.
//
// Getting that backwards is not a cosmetic bug. The union is ordered by each
// board's own `sortOrder` across boards and sweeps in the ceremony lanes (Risks,
// Questions, Start, Stop, Continue) from any Sprint Planning or Review board, so
// a picker that preferred it would offer statuses no Kanban board can display —
// pick one and the ticket is orphaned.
//
// The rule lives in two files that must never drift apart: the drill-down sheet
// (board-item-detail-sheet.tsx) decides what the Status PICKER offers, and
// Sprint Health (dashboard-view.tsx) decides what "done" MEANS in its numbers.
// This file drives both against the SAME fixtures, so a change to one that is
// not made to the other fails here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@/types/models";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/projects/ACME/boards/host",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("react-grid-layout", () => ({
  GridLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  verticalCompactor: () => [],
}));

// Renders the option list the sheet would show: `statusColumns ?? columns`, the
// one line of CardDetailSheet the wrapper feeds.
vi.mock("@/components/work-items/card-detail-sheet", () => ({
  CardDetailSheet: ({
    open,
    columns,
    statusColumns,
  }: {
    open: boolean;
    columns: { key: string; name: string }[];
    statusColumns?: { key: string; name: string }[];
  }) =>
    open ? (
      <ul data-testid="picker">
        {(statusColumns ?? columns).map((c) => (
          <li key={c.key}>{c.name}</li>
        ))}
      </ul>
    ) : null,
}));

import { BoardItemDetailSheet } from "@/components/work-items/board-item-detail-sheet";
import { DashboardView } from "@/components/boards/dashboard/dashboard-view";

/**
 * The host board's OWN workflow. Deliberately not alphabetical and deliberately
 * not a subset-in-order of the union below: "Doing" sorts before "Blocked" here,
 * so a test that passed on content alone but lost the board's ORDER still fails.
 */
const HOST_COLUMNS = [
  { id: "h1", boardId: "host", key: "queued", name: "Queued", category: "TODO", sortOrder: 0 },
  { id: "h2", boardId: "host", key: "doing", name: "Doing", category: "IN_PROGRESS", sortOrder: 1 },
  { id: "h3", boardId: "host", key: "blocked", name: "Blocked", category: "IN_PROGRESS", sortOrder: 2 },
  { id: "h4", boardId: "host", key: "shipped", name: "Shipped", category: "DONE", sortOrder: 3 },
];

/** A Sprint Review board's lanes. These are NOT statuses a delivery board shows. */
const CEREMONY_COLUMNS = [
  { id: "r1", boardId: "retro", key: "start", name: "Start", category: "TODO", sortOrder: 0 },
  { id: "r2", boardId: "retro", key: "stop", name: "Stop", category: "TODO", sortOrder: 1 },
  { id: "r3", boardId: "retro", key: "continue", name: "Continue", category: "TODO", sortOrder: 2 },
];

/**
 * Another delivery board — and note `blocked`: the SAME key the host board owns,
 * under a different name and a different category. That is ordinary (the union's
 * "first name wins" rule exists because boards disagree), and it is what makes
 * the precedence observable: this board sorts FIRST in the project's board list,
 * so a union that outranked the host board would relabel "Blocked" to "Held" and
 * recategorise it from IN_PROGRESS to TODO — moving a number on Sprint Health.
 */
const KANBAN_COLUMNS = [
  { id: "k1", boardId: "kanban", key: "todo", name: "To Do", category: "TODO", sortOrder: 0 },
  { id: "k2", boardId: "kanban", key: "blocked", name: "Held", category: "TODO", sortOrder: 1 },
  { id: "k3", boardId: "kanban", key: "review", name: "Review", category: "IN_PROGRESS", sortOrder: 2 },
  { id: "k4", boardId: "kanban", key: "done", name: "Done", category: "DONE", sortOrder: 3 },
];

const HOST_LABELS = ["Queued", "Doing", "Blocked", "Shipped"];
const CEREMONY_LABELS = ["Start", "Stop", "Continue"];

const ITEM = { id: "W1", title: "Falcon SSO integration", columnKey: "doing" } as WorkItem;

const mkItem = (over: Record<string, unknown>) => ({
  id: String(over.id),
  title: String(over.title ?? "Item"),
  ticketNumber: Number(over.ticketNumber ?? 1),
  columnKey: "queued",
  priority: "MEDIUM",
  storyPoints: null,
  completedAt: null,
  dueDate: null,
  intervalId: null,
  assigneeId: null,
  createdById: "u1",
  workCategory: "BUSINESS",
  tags: [],
  customFields: {},
  ...over,
});

// One item per host status. Read through the HOST board's categories that is
// 1 done / 2 in progress; read through the union's it is a different answer,
// because "shipped" is not a key the other boards know.
const ITEMS = [
  mkItem({ id: "1", ticketNumber: 1, columnKey: "queued" }),
  mkItem({ id: "2", ticketNumber: 2, columnKey: "doing" }),
  mkItem({ id: "3", ticketNumber: 3, columnKey: "blocked" }),
  mkItem({
    id: "4",
    ticketNumber: 4,
    columnKey: "shipped",
    completedAt: new Date().toISOString(),
  }),
];

/**
 * @param hostColumns what the host board itself owns — `[]` is the board added
 *   through `POST /boards`, which seeds none.
 */
function stubFetch(hostColumns: typeof HOST_COLUMNS | []) {
  const host = { id: "host", name: "Host board", columns: hostColumns };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url).split("?")[0];
      const body = u.endsWith("/boards/host")
        ? host
        : u.endsWith("/boards")
        ? [
            // The host board is NOT first: the union takes the first name and
            // category it meets for a key, so on `blocked` this board wins the
            // union — which is precisely the outcome the host board must beat.
            { id: "kanban", name: "Board", columns: KANBAN_COLUMNS },
            { id: "retro", name: "Sprint Review", columns: CEREMONY_COLUMNS },
            host,
          ]
        : u.endsWith("/work-items/W1")
        ? ITEM
        : u.endsWith("/interval-changes")
        ? { changes: [], truncated: false }
        : u.endsWith("/work-items")
        ? ITEMS
        : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderSheet() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BoardItemDetailSheet
        itemId="W1"
        onOpenChange={() => {}}
        orgId="o1"
        projectId="p1"
        boardId="host"
      />
    </QueryClientProvider>,
  );
}

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardView orgId="o1" projectId="p1" projectKey="ACME" boardId="host" />
    </QueryClientProvider>,
  );
}

/** The labels the Status picker offers, in order. */
async function pickerLabels() {
  await waitFor(() => expect(screen.getByTestId("picker")).toBeTruthy());
  return Array.from(screen.getByTestId("picker").children).map((li) => li.textContent);
}

/** The status names Sprint Health's distribution chart resolved items to. */
async function dashboardCategories() {
  await waitFor(() => expect(screen.getAllByTestId("metric-completed").length).toBeGreaterThan(0));
  return {
    completed: screen.getAllByTestId("metric-completed")[0].textContent,
    inProgress: screen.getAllByTestId("metric-in-progress")[0].textContent,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("status columns — the host board's own columns win when it has any", () => {
  it("the Status picker offers the host board's columns, in the host board's order", async () => {
    // The regression this pins: preferring the project-wide union here replaces a
    // Table/Calendar/RAID board's real workflow on a template-created project
    // with a cross-board ordering, and offers ceremony lanes that orphan the
    // ticket.
    stubFetch(HOST_COLUMNS);
    renderSheet();

    expect(await pickerLabels()).toEqual(HOST_LABELS);
  });

  it("the picker offers no ceremony lane when the host board has its own columns", async () => {
    stubFetch(HOST_COLUMNS);
    renderSheet();
    await pickerLabels();

    for (const lane of CEREMONY_LABELS) {
      expect(screen.queryByText(lane), `"${lane}" is a retro lane, not a status`).toBeNull();
    }
  });

  it("Sprint Health reads categories from the host board's columns too", async () => {
    // The SAME precedence, in the other file, and the assertion that proves it:
    // the host board calls `blocked` IN_PROGRESS, the board that wins the union
    // calls it TODO. Read through the host board this is 2 in progress; read
    // through the union it would be 1.
    stubFetch(HOST_COLUMNS);
    renderDashboard();

    expect(await dashboardCategories()).toEqual({ completed: "1", inProgress: "2" });
  });

  it("the picker shows the host board's NAME for a key two boards disagree on", async () => {
    // `blocked` is "Blocked" here and "Held" on the board that wins the union.
    stubFetch(HOST_COLUMNS);
    renderSheet();
    await pickerLabels();

    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.queryByText("Held")).toBeNull();
  });
});

describe("status columns — the project's union is the fallback when it has none", () => {
  it("the Status picker falls back to the project's statuses", async () => {
    stubFetch([]);
    renderSheet();

    // Union across the project's boards: the ceremony board's lanes are in it,
    // which is exactly why it must never outrank a board with columns of its own.
    const labels = await pickerLabels();
    expect(labels).toContain("Review");
    expect(labels).toContain("Done");
    expect(labels.length).toBeGreaterThan(0);
  });

  it("Sprint Health falls back to the project's statuses too", async () => {
    stubFetch([]);
    renderDashboard();

    // Through the union, "shipped" and "blocked" are unknown keys and fall to
    // TODO, so only the items whose keys the other boards DO know are counted.
    // The point is that both components fell back together — not that the
    // numbers match the host-board reading, which they cannot.
    const { completed, inProgress } = await dashboardCategories();
    expect(completed).toBe("0");
    expect(inProgress).toBe("0");
  });
});
