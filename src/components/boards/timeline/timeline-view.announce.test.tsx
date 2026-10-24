// @vitest-environment jsdom
// The Gantt says what a reschedule did, out loud.
//
// A drag ended in a generic "Schedule updated" toast and undo/redo said nothing,
// so someone using a screen reader couldn't tell which item moved, where to,
// whether others moved with it, or that it could be taken back. A polite
// live region now names all of that after a drop, an undo and a redo.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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


const announcer = () => screen.getByTestId("gantt-announcer");
// The chart works in the viewer's local days, so the expected sentences are
// built the same way and the tests hold in any timezone.
const fmtr = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmt = (v: unknown) => fmtr.format(new Date(String(v)));
const startOfLocalDay = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
};
const CASCADE = [
  {
    id: "i3",
    reason: "successor-shift",
    before: { startDate: "2026-01-15T00:00:00.000Z", dueDate: "2026-01-25T00:00:00.000Z" },
    after: { startDate: "2026-01-24T00:00:00.000Z", dueDate: "2026-02-03T00:00:00.000Z" },
  },
];

describe("TimelineView: reschedules are announced to screen readers", () => {
  it("the announcer is a polite status region, silent until something moves", async () => {
    await renderTimeline();
    expect(announcer().getAttribute("role")).toBe("status");
    expect(announcer().getAttribute("aria-live")).toBe("polite");
    expect(announcer().textContent).toBe("");
  });

  it("a drop names the item, its new dates, the other items that moved with it, and how to undo", async () => {
    cascadeFor = { i2: CASCADE };
    await renderTimeline();
    dragRight("i2");
    await waitFor(() => expect(announcer().textContent).toMatch(/^Moved FSC-102, Item 2 to /));
    const text = announcer().textContent!;
    expect(text).toMatch(/1 other item moved with it\./);
    expect(text).toMatch(/Control Z or Command Z to undo/);
    // The new dates, not the old ones.
    const put = putLog[0].body;
    expect(text).toContain(`to ${fmt(put.startDate)} to ${fmt(put.dueDate)}.`);
  });

  it("undo and redo each say what they did, and the keyboard shortcut is announced the same way", async () => {
    cascadeFor = { i2: CASCADE };
    await renderTimeline();
    dragRight("i2");
    await waitFor(() => expect(announcer().textContent).toMatch(/^Moved/));

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() =>
      expect(announcer().textContent).toBe(
        `Undid the change to FSC-102, Item 2: back to ${fmt(startOfLocalDay("2026-01-10"))} to ${fmt(startOfLocalDay("2026-02-01"))}. 1 other item moved back.`,
      ),
    );

    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(announcer().textContent).toMatch(/^Redid the change to FSC-102, Item 2: /));

    // Each announcement clears the region first and lands a tick later, so the
    // same sentence twice in a row is still read out (a live region only speaks
    // when its text changes).
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(announcer().textContent).toBe("");
    await waitFor(() => expect(announcer().textContent).toMatch(/^Undid/));
  });
});
