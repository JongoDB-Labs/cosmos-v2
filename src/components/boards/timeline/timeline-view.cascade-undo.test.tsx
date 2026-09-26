// @vitest-environment jsdom
// Undo has to take back the WHOLE cascade (COSMOS-154 follow-up).
//
// Dragging a bar now cascades on the server — parents widen, downstream
// successors shift — and the rule doing it is deliberately one-directional: only
// a slip travels downstream, and a parent expands but never shrinks. So putting
// the dragged bar back cascades NOTHING. An Undo that knew only about that bar
// therefore restored one item and left every item it had pushed stranded at its
// slipped dates, with no way back short of editing each by hand. The button says
// "Undo reschedule"; it undid a third of one.
//
// The same mechanism guards the other half of the defect: a user action that
// writes several items sends them in series, each naming the ones already
// settled, so a dependent shared by two of them is moved once rather than once
// per request (and by a fixed amount rather than one that depended on which
// request happened to land first).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
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

const ITEMS = [
  item(1, "2026-01-05", "2026-01-20"),
  item(2, "2026-01-10", "2026-02-01"),
  item(3, "2026-01-15", "2026-01-25"),
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
const dayOf = (v: unknown) => String(v).slice(0, 10);

/** Drag i2's bar to the right, committing a slip. */
function dragRight(id: string) {
  fireEvent.pointerDown(bar(id), { clientX: 0 });
  fireEvent.pointerMove(bar(id), { clientX: 120 });
  fireEvent.pointerUp(bar(id), { clientX: 120 });
}

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

describe("TimelineView — Undo takes the cascade back with the bar", () => {
  // The epic i1 was stretched to cover the slipped i2, and the successor i3 was
  // pushed out behind it. Neither can be recovered by re-saving i2 alone.
  const CASCADE = [
    {
      id: "i1",
      reason: "parent-envelope",
      before: { startDate: "2026-01-05T00:00:00.000Z", dueDate: "2026-01-20T00:00:00.000Z" },
      after: { startDate: "2026-01-05T00:00:00.000Z", dueDate: "2026-02-10T00:00:00.000Z" },
    },
    {
      id: "i3",
      reason: "successor-shift",
      before: { startDate: "2026-01-15T00:00:00.000Z", dueDate: "2026-01-25T00:00:00.000Z" },
      after: { startDate: "2026-01-24T00:00:00.000Z", dueDate: "2026-02-03T00:00:00.000Z" },
    },
  ];

  async function dragThenUndo() {
    cascadeFor = { i2: CASCADE };
    await renderTimeline();
    dragRight("i2");
    // Undo arms only once the save lands — what else moved is the server's
    // answer, not something the gesture knows.
    await waitFor(() => expect(putLog).toHaveLength(1));
    const undoBtn = screen.getByRole("button", { name: /undo/i });
    await waitFor(() => expect(undoBtn).not.toBeDisabled());
    fireEvent.click(undoBtn);
    await waitFor(() => expect(putLog).toHaveLength(4));
  }

  it("restores every item the cascade moved, not just the dragged bar", async () => {
    await dragThenUndo();
    const restored = putLog.slice(1);
    expect(restored.map((p) => p.id).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("puts each of them back at the dates it actually held before", async () => {
    await dragThenUndo();
    const byId = Object.fromEntries(putLog.slice(1).map((p) => [p.id, p.body]));
    // The stretched epic's finish comes back in…
    expect(dayOf(byId.i1.dueDate)).toBe("2026-01-20");
    // …and the pushed successor returns to its own span, not the epic's.
    expect(dayOf(byId.i3.startDate)).toBe("2026-01-15");
    expect(dayOf(byId.i3.dueDate)).toBe("2026-01-25");
  });

  it("restores the dragged bar to where the drag started", async () => {
    await dragThenUndo();
    const dragged = putLog.slice(1).find((p) => p.id === "i2")!;
    expect(dayOf(dragged.body.startDate)).toBe("2026-01-10");
    expect(dayOf(dragged.body.dueDate)).toBe("2026-02-01");
  });

  it("tells every restore about the others, so none of them re-cascades", async () => {
    await dragThenUndo();
    // Without this, restoring the child would immediately widen the epic back
    // out from the child's still-slipped siblings — the undo undoing itself.
    for (const put of putLog.slice(1)) {
      const skip = put.body.cascadeSkipIds as string[];
      expect([...skip].sort()).toEqual(["i1", "i2", "i3"].filter((id) => id !== put.id));
    }
  });

  it("redo re-applies the whole cascade, not just the bar", async () => {
    await dragThenUndo();
    fireEvent.click(screen.getByRole("button", { name: /redo/i }));
    await waitFor(() => expect(putLog).toHaveLength(7));
    const redone = putLog.slice(4);
    expect(redone.map((p) => p.id).sort()).toEqual(["i1", "i2", "i3"]);
    const byId = Object.fromEntries(redone.map((p) => [p.id, p.body]));
    expect(dayOf(byId.i1.dueDate)).toBe("2026-02-10");
    expect(dayOf(byId.i3.startDate)).toBe("2026-01-24");
  });

  it("a drag that cascades nothing still undoes to one PUT", async () => {
    cascadeFor = {};
    await renderTimeline();
    dragRight("i2");
    await waitFor(() => expect(putLog).toHaveLength(1));
    const undoBtn = screen.getByRole("button", { name: /undo/i });
    await waitFor(() => expect(undoBtn).not.toBeDisabled());
    fireEvent.click(undoBtn);
    await waitFor(() => expect(putLog).toHaveLength(2));
    expect(putLog[1].id).toBe("i2");
    expect(putLog[1].body.cascadeSkipIds).toEqual([]);
  });
});

describe("TimelineView — one user action cascades a dependent once", () => {
  it("shifts a multi-row selection in series, each naming its siblings", async () => {
    await renderTimeline();
    fireEvent.click(screen.getByLabelText("Select FSC-101"));
    fireEvent.click(screen.getByLabelText("Select FSC-103"));
    fireEvent.click(screen.getByRole("button", { name: "+1d" }));
    await waitFor(() => expect(putLog).toHaveLength(2));

    expect(putLog.map((p) => p.id).sort()).toEqual(["i1", "i3"]);
    // Each request declares the other, so neither one's cascade rewrites the
    // dates the other is setting by hand — nor walks past it into shared
    // downstream work that the other will already have moved.
    expect(putLog.find((p) => p.id === "i1")!.body.cascadeSkipIds).toEqual(["i3"]);
    expect(putLog.find((p) => p.id === "i3")!.body.cascadeSkipIds).toEqual(["i1"]);
  });

  it("carries what the FIRST request cascaded into the second's skip list", async () => {
    // The heart of the non-determinism: i1 and i3 both point at i2. Whichever
    // goes first moves i2; the second must be told, or it moves i2 again and the
    // item lands twice as far out as the user asked for — by an amount that
    // depended on which request happened to win the race.
    cascadeFor = {
      i1: [
        {
          id: "i2",
          reason: "successor-shift",
          before: { startDate: "2026-01-10T00:00:00.000Z", dueDate: "2026-02-01T00:00:00.000Z" },
          after: { startDate: "2026-01-11T00:00:00.000Z", dueDate: "2026-02-02T00:00:00.000Z" },
        },
      ],
    };
    await renderTimeline();
    fireEvent.click(screen.getByLabelText("Select FSC-101"));
    fireEvent.click(screen.getByLabelText("Select FSC-103"));
    fireEvent.click(screen.getByRole("button", { name: "+1d" }));
    await waitFor(() => expect(putLog).toHaveLength(2));

    const first = putLog[0];
    const second = putLog[1];
    expect(first.id).toBe("i1");
    expect(first.body.cascadeSkipIds).toEqual(["i3"]);
    // i2 was NOT in the selection and NOT in the first skip list — it is there
    // only because the first response reported moving it.
    expect([...(second.body.cascadeSkipIds as string[])].sort()).toEqual(["i1", "i2"]);
  });
});
