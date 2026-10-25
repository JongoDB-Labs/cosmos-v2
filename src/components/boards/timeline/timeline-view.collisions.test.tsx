// @vitest-environment jsdom
// Collisions on the Gantt (schedule-collisions.ts).
//
// A drop could silently lay a bar over a sibling's dates. For phases meant to
// run one after another that is a decision, so a drop that newly overlaps a
// sibling now waits for one: run them in parallel, push the sibling later or
// earlier, or cancel. Each choice is one save and one undo step.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  // The board's query bar (boards/shared/use-board-query) reads the URL too.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Dragging, Shift and undo/redo are all gated on ITEM_UPDATE.
const perms = vi.hoisted(() => ({ canEdit: true }));
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...actual,
    usePermissions: () => ({
      orgId: "o1",
      orgSlug: "acme",
      role: "ADMIN",
      permissions: 0n,
      can: () => perms.canEdit,
    }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/boards/shared/new-issue-button", () => ({ NewIssueButton: () => null }));
vi.mock("@/components/work-items/card-detail-sheet", () => ({ CardDetailSheet: () => null }));
vi.mock("@/components/boards/shared/filter-bar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/boards/shared/filter-bar")>();
  return { ...actual, FilterBar: () => null };
});

const item = (n: number, start: string, due: string) => ({
  id: `i${n}`,
  ticketNumber: 100 + n,
  title: `Item ${n}`,
  createdAt: start,
  startDate: start,
  dueDate: due,
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
});

// Two sibling phases under one parent, back to back: A (i1) then B (i2). i3
// belongs to another parent and i4 has none; neither may ever be asked about.
// Local midnights, so each date is the same calendar day in any timezone.
const lday = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
};
const ITEMS = [
  { ...item(1, lday("2026-01-05"), lday("2026-01-10")), parentId: "p" },
  { ...item(2, lday("2026-01-12"), lday("2026-01-20")), parentId: "p" },
  { ...item(3, lday("2026-01-11"), lday("2026-01-30")), parentId: "q" },
  item(4, lday("2026-01-11"), lday("2026-01-30")),
  { ...item(9, lday("2026-01-01"), lday("2026-02-15")), id: "p", parentId: null },
];

// What the PUT echoes back as `scheduleCascade` — swapped per test. Keyed by the
// item being PUT, so a batch can hand different answers to different requests.
let cascadeFor: Record<string, unknown[]> = {};
/** Every PUT, in the order the component issued them. */
const putLog: Array<{ id: string; body: Record<string, unknown> }> = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const id = url.split("/").pop()!;
      putLog.push({ id, body: JSON.parse(String(init.body)) });
      return Promise.resolve({ id, scheduleCascade: cascadeFor[id] ?? [] });
    }
    if (url.endsWith("/work-items")) return Promise.resolve(ITEMS);
    if (url.endsWith("/members")) return Promise.resolve([]);
    if (url.endsWith("/work-item-links")) return Promise.resolve([]);
    if (url.endsWith("/intervals")) return Promise.resolve([]);
    if (url.endsWith("/milestones")) return Promise.resolve([]);
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

import { TimelineView } from "./timeline-view";

async function renderTimeline() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TimelineView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />
    </QueryClientProvider>,
  );
  await screen.findByTestId("gantt-chart");
  return utils;
}

const bar = (id: string) => screen.getByTestId(`gantt-bar-${id}`);


beforeEach(() => {
  perms.canEdit = true;
  putLog.length = 0;
  cascadeFor = {};
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});



const DAY = 28; // px per day at the default zoom (BASE_DAY_WIDTH)
/** Drag i1 right by `days` (it ends Jan 10; i2 starts Jan 12). */
function dragI1(days: number) {
  fireEvent.pointerDown(bar("i1"), { clientX: 0 });
  fireEvent.pointerMove(bar("i1"), { clientX: days * DAY });
  fireEvent.pointerUp(bar("i1"), { clientX: days * DAY });
}
const localDay = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const iso = (v: unknown) => new Date(String(v)).toISOString();
const ld = (ymd: string) => localDay(ymd).toISOString();

describe("TimelineView: a drop onto a sibling waits for a decision", () => {
  it("holds the save and lists the sibling it would overlap", async () => {
    await renderTimeline();
    dragI1(5);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Overlaps another item")).toBeTruthy();
    const list = within(dialog).getByRole("list", { name: "Overlapping items" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("FSC-102, Item 2"),
    ]);
    // Nothing was saved, and the other parent's item and the top-level item
    // were never in question.
    expect(putLog).toHaveLength(0);
    expect(within(list).queryByText(/Item 3|Item 4/)).toBeNull();
  });

  it("Cancel puts the bar back: nothing is saved", async () => {
    await renderTimeline();
    dragI1(5);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(putLog).toHaveLength(0);
  });

  it("Run in parallel saves the drop as made, and nothing else", async () => {
    await renderTimeline();
    dragI1(5);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Run in parallel" }));
    await waitFor(() => expect(putLog).toHaveLength(1));
    expect(putLog[0].id).toBe("i1");
    expect(iso(putLog[0].body.startDate)).toBe(ld("2026-01-10"));
  });

  it("Push it later moves the sibling to start when the dropped one ends, in the same action", async () => {
    await renderTimeline();
    dragI1(5); // i1 now Jan 10 to Jan 15
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Push it later" }));
    await waitFor(() => expect(putLog).toHaveLength(2));
    expect(putLog.map((p) => p.id)).toEqual(["i1", "i2"]);
    // i2 keeps its 8 days and starts on i1's new last day (a handover).
    expect(iso(putLog[1].body.startDate)).toBe(ld("2026-01-15"));
    expect(iso(putLog[1].body.dueDate)).toBe(ld("2026-01-23"));
    // One action: i2's PUT is told about i1, so it doesn't cascade it again.
    expect(putLog[1].body.cascadeSkipIds).toEqual(["i1"]);
  });

  it("Push it earlier moves the sibling to end when the dropped one starts", async () => {
    await renderTimeline();
    dragI1(10); // i1 now Jan 15 to Jan 20, landing inside i2
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Push it earlier" }));
    await waitFor(() => expect(putLog).toHaveLength(2));
    expect(iso(putLog[1].body.startDate)).toBe(ld("2026-01-07"));
    expect(iso(putLog[1].body.dueDate)).toBe(ld("2026-01-15"));
  });

  it("one Undo takes back both the drop and the pushed sibling", async () => {
    await renderTimeline();
    dragI1(5);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Push it later" }));
    await waitFor(() => expect(putLog).toHaveLength(2));
    const undoBtn = screen.getByRole("button", { name: /undo/i });
    await waitFor(() => expect(undoBtn).not.toBeDisabled());
    fireEvent.click(undoBtn);
    await waitFor(() => expect(putLog).toHaveLength(4));
    const back = Object.fromEntries(putLog.slice(2).map((p) => [p.id, p.body]));
    expect(iso(back.i1.startDate)).toBe(ld("2026-01-05"));
    expect(back.i2.startDate).toBe(ITEMS[1].startDate);
    expect(back.i2.dueDate).toBe(ITEMS[1].dueDate);
    // And undo is not asked about: it restores, it doesn't re-drop.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a drop that overlaps no sibling saves straight away, as before", async () => {
    await renderTimeline();
    dragI1(1); // Jan 6 to Jan 11: ends before i2 starts
    await waitFor(() => expect(putLog).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
