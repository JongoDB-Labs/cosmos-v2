// @vitest-environment jsdom
// The Gantt's confirm step: a drop is previewed (schedule-preview) before it is
// saved, and waits for Save when the preview finds it moves more than the
// dragged bar, loads someone up, or a plugin added rows. A plain move still
// saves at once, and a preview that can't be had never blocks the save.
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
// What the preview endpoint answers, per test.
let preview: unknown = null;
const previewLog: Array<{ changes: Array<{ id: string }> }> = [];
/** Every PUT, in the order the component issued them. */
const putLog: Array<{ id: string; body: Record<string, unknown> }> = [];

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/schedule-preview")) {
      previewLog.push(JSON.parse(String(init!.body)));
      if (preview === "fail") return Promise.reject(new Error("offline"));
      return Promise.resolve(preview);
    }
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
  previewLog.length = 0;
  preview = null;
  cascadeFor = {};
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});



const DAY = 28; // px per day at the default zoom (BASE_DAY_WIDTH)
const ld = (ymd: string) => lday(ymd);
/** Drag i1 right by one day: Jan 6 to Jan 11, clear of its sibling i2. */
function dragI1() {
  fireEvent.pointerDown(bar("i1"), { clientX: 0 });
  fireEvent.pointerMove(bar("i1"), { clientX: DAY });
  fireEvent.pointerUp(bar("i1"), { clientX: DAY });
}
const impact = (over: Record<string, unknown> = {}) => ({
  changes: [{ itemId: "i1", before: { startDate: ld("2026-01-05"), dueDate: ld("2026-01-10") }, after: { startDate: ld("2026-01-06"), dueDate: ld("2026-01-11") } }],
  cascaded: [{ itemId: "i3", reason: "successor-shift", before: { startDate: ld("2026-01-11"), dueDate: ld("2026-01-30") }, after: { startDate: ld("2026-01-12"), dueDate: ld("2026-01-31") } }],
  allocation: [],
  sections: [{ key: "fees:fee", title: "Fee and rate", rows: [{ key: "rate", label: "Effective rate", before: "$100/h", after: "$95/h", tone: "warn" }] }],
  needsConfirm: true,
  ...over,
});

describe("TimelineView: the confirm step before a drop is saved", () => {
  it("asks the preview about exactly the dropped dates", async () => {
    await renderTimeline();
    dragI1();
    await waitFor(() => expect(previewLog).toHaveLength(1));
    expect(previewLog[0]).toEqual({ changes: [{ id: "i1", startDate: ld("2026-01-06"), dueDate: ld("2026-01-11") }] });
  });

  it("holds the save and shows what else moves and the plugin's rows", async () => {
    preview = impact();
    await renderTimeline();
    dragI1();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Save this schedule change?")).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Also moves" }).textContent).toContain("FSC-103, Item 3, waits on a moved item");
    expect(within(dialog).getByRole("region", { name: "Fee and rate" }).textContent).toContain("Effective rate");
    expect(putLog).toHaveLength(0);
  });

  it("Save saves the drop, as one undoable action", async () => {
    preview = impact();
    await renderTimeline();
    dragI1();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putLog).toHaveLength(1));
    expect(putLog[0].id).toBe("i1");
    await waitFor(() => expect(screen.getByRole("button", { name: /undo/i })).not.toBeDisabled());
  });

  it("Cancel saves nothing", async () => {
    preview = impact();
    await renderTimeline();
    dragI1();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(putLog).toHaveLength(0);
  });

  it("a plain move (nothing else moves, nobody loaded, no plugin rows) saves at once", async () => {
    preview = impact({ cascaded: [], sections: [], needsConfirm: false });
    await renderTimeline();
    dragI1();
    await waitFor(() => expect(putLog).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a preview that fails never blocks the save", async () => {
    preview = "fail";
    await renderTimeline();
    dragI1();
    await waitFor(() => expect(putLog).toHaveLength(1));
  });

  it("a collision's choice is previewed too, the pushed sibling included", async () => {
    await renderTimeline();
    fireEvent.pointerDown(bar("i1"), { clientX: 0 });
    fireEvent.pointerMove(bar("i1"), { clientX: 5 * DAY });
    fireEvent.pointerUp(bar("i1"), { clientX: 5 * DAY });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Push it later" }));
    await waitFor(() => expect(previewLog).toHaveLength(1));
    expect(previewLog[0].changes.map((c) => c.id)).toEqual(["i1", "i2"]);
  });

  it("undo and redo restore without asking", async () => {
    preview = impact({ needsConfirm: false });
    await renderTimeline();
    dragI1();
    await waitFor(() => expect(putLog).toHaveLength(1));
    const undoBtn = screen.getByRole("button", { name: /undo/i });
    await waitFor(() => expect(undoBtn).not.toBeDisabled());
    preview = impact();
    fireEvent.click(undoBtn);
    await waitFor(() => expect(putLog).toHaveLength(2));
    expect(previewLog).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
