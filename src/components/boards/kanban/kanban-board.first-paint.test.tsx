// @vitest-environment jsdom
// The board painted only after SEVEN requests had all come back.
//
// `fetchData` awaited `Promise.all([board, items, members, links, milestones,
// teams, intervals])` and cleared `loading` in its `finally`, so the skeleton
// stayed up until the SLOWEST of the seven resolved. Cards need exactly two of
// them — `board` for its columns and `items` for the cards. The other five feed
// the filter bar and card decorations, and three were already
// `.catch(() => null)` best-effort, yet every one of them still gated the
// first paint.
//
// Reported from production: "boards ... taking SO LONG to load".
// Measured on prod, the database is not the cause: the item query runs in
// 4.2ms and its relation includes in another ~5ms, compression is on, and
// server TTFB is ~115ms. What the board does with that is the cost — and
// waiting on five requests it does not need before showing anything is the
// cheapest part of it to stop doing.
//
// These cases pin the split: the two critical requests gate the paint, the
// five auxiliary ones do not, and their data still lands when it arrives.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!("EventSource" in globalThis)) {
  globalThis.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}

vi.mock("@/components/providers/permissions-provider", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: 0n, can: () => true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/P1/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { KanbanBoard } from "./kanban-board";

const BOARD = {
  id: "b1", name: "Board", type: "KANBAN", config: {},
  columns: [{ id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" }],
};
const ITEM = {
  id: "i1", orgId: "o1", projectId: "p1", workItemTypeId: "t1", title: "A visible card",
  description: "", columnKey: "todo", priority: "MEDIUM", assigneeId: null, assignees: [],
  parentId: null, intervalId: null, ticketNumber: 1, tags: [], customFields: {},
  archivedAt: null, startDate: null, dueDate: null, completedAt: null, storyPoints: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
};

/** Which URL fragments should hang forever rather than answer. */
function installFetch(stall: string[], onStalled?: () => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (stall.some((frag) => u.includes(frag))) {
        onStalled?.();
        return new Promise<Response>(() => {}); // never settles
      }
      const body = u.endsWith("/boards/b1") ? BOARD : u.endsWith("/work-items") ? [ITEM] : [];
      return new Response(JSON.stringify({ data: body }), { status: 200 });
    }),
  );
}

function renderKanban() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanBoard orgId="o1" projectId="p1" projectKey="P1" boardId="b1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Kanban first paint", () => {
  it("paints when board and items are back, with the other five still in flight", async () => {
    // The whole point: members, links, milestones, teams and intervals never
    // answer, and the board still shows its cards.
    installFetch(["/members", "/work-item-links", "/milestones", "/teams", "/intervals"]);
    renderKanban();
    expect(await screen.findByText("A visible card", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("still waits for the items", async () => {
    // The control in the other direction: `items` is critical, so stalling it
    // must NOT paint. Without this, the case above would pass just as happily
    // against a board that painted before it had any data at all.
    installFetch(["/work-items"]);
    renderKanban();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("A visible card")).toBeNull();
  });

  it("still waits for the board's columns", async () => {
    installFetch(["/boards/b1"]);
    renderKanban();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("A visible card")).toBeNull();
  });

  it("takes the auxiliary data once it does arrive", async () => {
    // Deferring those five must not mean dropping them.
    installFetch([]);
    renderKanban();
    await screen.findByText("A visible card", {}, { timeout: 3000 });
    await waitFor(() => {
      const asked = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
      for (const frag of ["/members", "/teams", "/intervals"]) {
        expect(asked.some((u) => u.includes(frag)), `never requested ${frag}`).toBe(true);
      }
    });
  });
});
