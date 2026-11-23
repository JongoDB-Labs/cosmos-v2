// @vitest-environment jsdom
// Reported: "Creating a new work item requires a hard refresh — users see a
// skeleton UI that never renders."
//
// Two defects on the Kanban board, both pinned here:
//
// 1. A stuck skeleton. `fetchData` drops a superseded fetch's result (it checks
//    `seq` against the latest), and only a NON-silent fetch could clear
//    `loading`. Creating an item started a loud refetch; ~400ms later the
//    realtime `work-item.created` event started a silent one, which became the
//    latest. The loud one then returned early, the silent one was not allowed
//    to clear `loading`, and the skeleton stayed up until a hard refresh. Slow
//    boards made the overlap likely.
//
// 2. A stale list. The post-create refetch honoured the 30s staleTime, so a
//    board loaded moments earlier was served from cache — without the item
//    just created. It must also not JOIN an items read already in flight from
//    before the create, and must not re-read the board's columns (a failed
//    columns read would replace a loaded board with an error).
import { describe, it, expect, vi, afterEach } from "vitest";
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

// Capture the board's realtime handler so a test can deliver an event.
const realtime = vi.hoisted(() => ({ fire: null as null | (() => void) }));
vi.mock("@/hooks/use-work-item-realtime", () => ({
  useWorkItemRealtime: (_o: string, _p: string, cb: () => void) => {
    realtime.fire = cb;
  },
}));

// Stand-in create button: calls the board's `onCreated` as the real dialog
// does after a successful POST.
vi.mock("@/components/boards/shared/new-work-item-button", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  NewWorkItemButton: ({ onCreated }: { onCreated: () => void }) => (
    <button type="button" onClick={onCreated}>
      fake-create
    </button>
  ),
}));

import { KanbanBoard } from "./kanban-board";

const BOARD = {
  id: "b1", name: "Board", type: "KANBAN", config: {},
  columns: [{ id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" }],
};
function item(id: string, title: string, n: number) {
  return {
    id, orgId: "o1", projectId: "p1", workItemTypeId: "t1", title,
    description: "", columnKey: "todo", priority: "MEDIUM", assigneeId: null, assignees: [],
    parentId: null, intervalId: null, ticketNumber: n, tags: [], customFields: {},
    archivedAt: null, startDate: null, dueDate: null, completedAt: null, storyPoints: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
  };
}
const EXISTING = item("i1", "Existing card", 1);
const CREATED = item("i2", "Just-created card", 2);

function respond(body: unknown) {
  return new Response(JSON.stringify({ data: body }), { status: 200 });
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
  realtime.fire = null;
});

describe("Kanban refresh after creating an item", () => {
  it("clears the skeleton when a silent realtime refetch supersedes the loud one", async () => {
    // The loud mount fetch's items request is held open; a realtime event
    // starts a silent refetch on top of it; then the server answers.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let itemCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/boards/b1")) return respond(BOARD);
        if (u.endsWith("/work-items")) {
          itemCalls += 1;
          if (itemCalls === 1) await held;
          return respond([EXISTING]);
        }
        return respond([]);
      }),
    );

    renderKanban();
    expect(realtime.fire).toBeTypeOf("function");
    realtime.fire!();
    // The board debounces realtime refetches by 400ms.
    await new Promise((r) => setTimeout(r, 550));
    release();

    expect(await screen.findByText("Existing card", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("shows the created item at once, not the cached list, with no skeleton meanwhile", async () => {
    let created = false;
    let releasePostCreate: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/boards/b1")) return respond(BOARD);
        if (u.endsWith("/work-items")) {
          if (created) {
            // Hold the post-create read so the test can look at the board
            // WHILE it is pending.
            await new Promise<void>((r) => (releasePostCreate = r));
            return respond([EXISTING, CREATED]);
          }
          return respond([EXISTING]);
        }
        return respond([]);
      }),
    );

    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    // The POST has landed server-side; the dialog calls onCreated. No realtime
    // event is delivered here, so only the board's own refetch can show it.
    created = true;
    fireEvent.click(screen.getByText("fake-create"));

    // Mid-refresh: the skeleton replaces every card, so the existing card
    // still being on screen is what proves there is no skeleton flash.
    await vi.waitFor(() => expect(releasePostCreate).not.toBeNull());
    expect(screen.getByText("Existing card")).toBeTruthy();

    releasePostCreate!();
    expect(await screen.findByText("Just-created card", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("does not reuse an items read that started before the create", async () => {
    // A realtime refetch is mid-flight, holding the PRE-create list, when the
    // create lands. The post-create refresh must read again, not join it.
    let created = false;
    let releaseOld: (() => void) | null = null;
    let itemCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/boards/b1")) return respond(BOARD);
        if (u.endsWith("/work-items")) {
          itemCalls += 1;
          const snapshot = created ? [EXISTING, CREATED] : [EXISTING];
          if (itemCalls === 2) await new Promise<void>((r) => (releaseOld = r));
          return respond(snapshot);
        }
        return respond([]);
      }),
    );

    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    // Another client's change: a silent, fresh refetch starts and is held,
    // having captured the list without the new item.
    realtime.fire!();
    await vi.waitFor(() => expect(releaseOld).not.toBeNull(), { timeout: 2000 });

    created = true;
    fireEvent.click(screen.getByText("fake-create"));
    releaseOld!();

    expect(await screen.findByText("Just-created card", {}, { timeout: 3000 })).toBeTruthy();
  });

  it.each([
    ["the post-create items read fails", "create"],
    ["the realtime refresh's columns read fails", "realtime"],
  ] as const)("keeps the loaded board when %s", async (_label, trigger) => {
    // A background refresh that fails on a board already showing must keep it
    // (and tell the user), not swap every card for "Failed to load board".
    let broken = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        const down = () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        if (u.endsWith("/boards/b1")) return broken ? down() : respond(BOARD);
        if (u.endsWith("/work-items")) return broken ? down() : respond([EXISTING]);
        return respond([]);
      }),
    );
    const { notifyError } = await import("@/lib/errors/notify");
    vi.mocked(notifyError).mockClear();

    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    broken = true;
    if (trigger === "create") fireEvent.click(screen.getByText("fake-create"));
    else realtime.fire!();

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalled(), { timeout: 3000 });
    expect(screen.getByText("Existing card")).toBeTruthy();
    expect(screen.queryByText("Failed to load board")).toBeNull();
  });

  it("keeps the loaded board if re-reading its columns would fail", async () => {
    // Only the item list changes on create. A columns read that fails after a
    // successful create must not replace the board with an error.
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/boards/b1")) {
          return created
            ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
            : respond(BOARD);
        }
        if (u.endsWith("/work-items")) return respond(created ? [EXISTING, CREATED] : [EXISTING]);
        return respond([]);
      }),
    );

    renderKanban();
    await screen.findByText("Existing card", {}, { timeout: 3000 });

    created = true;
    fireEvent.click(screen.getByText("fake-create"));

    expect(await screen.findByText("Just-created card", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("Existing card")).toBeTruthy();
    expect(screen.queryByText("Failed to load board")).toBeNull();
  });
});
