// @vitest-environment jsdom
// A failed background refresh must not replace a loaded board with a full
// error. The board stays, a "couldn't refresh" toast shows, and the next good
// refresh clears it. A first load that fails, or a refresh the server refuses
// (401/403, or 404 on the board / items), is a LoadError with "Try again".
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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

const toasts = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", async (orig) => {
  const real = (await orig()) as { toast: (...a: unknown[]) => unknown };
  const toast = Object.assign((...a: unknown[]) => real.toast(...a), real.toast, toasts);
  return { ...(real as object), toast };
});

const realtime = vi.hoisted(() => ({ fire: null as null | (() => void) }));
vi.mock("@/hooks/use-work-item-realtime", () => ({
  useWorkItemRealtime: (_o: string, _p: string, cb: () => void) => {
    realtime.fire = cb;
  },
}));

import { KanbanBoard } from "./kanban-board";
import { REFRESH_FAILED_MESSAGE } from "@/components/boards/shared/use-refresh-failed-notice";

function board(id: string, column: string) {
  return {
    id, name: `Board ${id}`, type: "KANBAN", config: {},
    columns: [{ id: `c-${id}`, key: "todo", name: column, sortOrder: 0, category: "TODO" }],
  };
}
const ITEM = {
  id: "i1", orgId: "o1", projectId: "p1", workItemTypeId: "t1", title: "Existing card",
  description: "", columnKey: "todo", priority: "MEDIUM", assigneeId: null, assignees: [],
  parentId: null, intervalId: null, ticketNumber: 1, tags: [], customFields: {},
  archivedAt: null, startDate: null, dueDate: null, completedAt: null, storyPoints: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
};

const ok = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 });
const fail = (status: number) =>
  new Response(JSON.stringify({ error: `HTTP ${status}` }), { status });

/** What the server answers, per read; change between steps. */
const server = { board: 200, items: 200, board2: 200 };

beforeEach(() => {
  server.board = 200;
  server.items = 200;
  server.board2 = 200;
  toasts.warning.mockClear();
  toasts.dismiss.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/boards/b1")) return server.board === 200 ? ok(board("b1", "To do")) : fail(server.board);
      if (u.endsWith("/boards/b2")) return server.board2 === 200 ? ok(board("b2", "Doing")) : fail(server.board2);
      if (u.endsWith("/work-items")) return server.items === 200 ? ok([ITEM]) : fail(server.items);
      return ok([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  realtime.fire = null;
});

function renderKanban(boardId = "b1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (id: string) => (
    <QueryClientProvider client={qc}>
      <KanbanBoard orgId="o1" projectId="p1" projectKey="P1" boardId={id} />
    </QueryClientProvider>
  );
  const r = render(ui(boardId));
  return { ...r, switchTo: (id: string) => r.rerender(ui(id)) };
}

/** Deliver a realtime event and wait out the 400ms debounce plus the refetch. */
async function realtimeRefresh() {
  realtime.fire!();
  await new Promise((r) => setTimeout(r, 600));
}

const tryAgain = () => screen.queryByRole("button", { name: "Try again" });

describe("Kanban: a failed background refresh keeps the loaded board", () => {
  it("keeps the columns and cards, shows the toast, and clears it after a good refresh", async () => {
    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    server.items = 500;
    await realtimeRefresh();
    await vi.waitFor(() =>
      expect(toasts.warning).toHaveBeenCalledWith(REFRESH_FAILED_MESSAGE, expect.anything()),
    );
    expect(screen.getByText("Existing card")).toBeTruthy();
    expect(screen.getByText("To do")).toBeTruthy();
    expect(tryAgain()).toBeNull();

    server.items = 200;
    await realtimeRefresh();
    await vi.waitFor(() => expect(toasts.dismiss).toHaveBeenCalled());
    expect(screen.getByText("Existing card")).toBeTruthy();
    expect(toasts.warning).toHaveBeenCalledTimes(1);
  });

  it("a first load that fails is a LoadError, and Try again recovers", async () => {
    server.items = 500;
    renderKanban();
    await vi.waitFor(() => expect(tryAgain()).not.toBeNull(), { timeout: 3000 });
    expect(screen.getByText("Failed to load board")).toBeTruthy();

    server.items = 200;
    fireEvent.click(tryAgain()!);
    expect(await screen.findByText("Existing card", {}, { timeout: 3000 })).toBeTruthy();
    expect(tryAgain()).toBeNull();
  });

  it("a 403 on refresh is a LoadError, not stale data", async () => {
    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    server.items = 403;
    await realtimeRefresh();
    await vi.waitFor(() => expect(tryAgain()).not.toBeNull());
    expect(screen.queryByText("Existing card")).toBeNull();
  });

  it("a 403 is not hidden behind a 500 on the other read", async () => {
    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    server.board = 500;
    server.items = 403;
    await realtimeRefresh();
    await vi.waitFor(() => expect(tryAgain()).not.toBeNull());
    expect(screen.queryByText("Existing card")).toBeNull();
  });

  it("a board switch whose first load fails shows a LoadError, never the old board", async () => {
    const { switchTo } = renderKanban("b1");
    await screen.findByText("To do", {}, { timeout: 3000 });

    // A debounced refresh for b1 is pending when the user switches to b2.
    server.board2 = 500;
    realtime.fire!();
    switchTo("b2");
    await vi.waitFor(() => expect(tryAgain()).not.toBeNull(), { timeout: 3000 });

    await new Promise((r) => setTimeout(r, 600)); // past the old debounce
    expect(tryAgain()).not.toBeNull();
    expect(screen.queryByText("To do")).toBeNull();
    expect(screen.queryByText("Existing card")).toBeNull();
  });
});
