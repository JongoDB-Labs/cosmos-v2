// @vitest-environment jsdom
//
// A board saved from the Issues view ("Save as board") stores that view's
// filter in Board.config.savedFilter. It used to be written and never read, so
// the saved board showed every item in the project. The Kanban board now scopes
// to it and says so.
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

function item(id: string, title: string, priority: string) {
  return {
    id, orgId: "o1", projectId: "p1", workItemTypeId: "t1", title, description: "",
    columnKey: "todo", priority, assigneeId: null, assignees: [], parentId: null, intervalId: null,
    ticketNumber: Number(id.slice(1)), tags: [], customFields: {}, archivedAt: null,
    startDate: null, dueDate: null, completedAt: null, storyPoints: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
  };
}
const ITEMS = [item("i1", "Critical outage", "CRITICAL"), item("i2", "Polish copy", "LOW")];

function installFetch(config: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/boards/b1")
        ? { id: "b1", name: "Saved", type: "KANBAN", config, columns: [{ id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" }] }
        : url.endsWith("/work-items")
          ? ITEMS
          : [];
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

describe("KanbanBoard — a board saved from Issues keeps its filter", () => {
  it("shows only items matching config.savedFilter, and says the board is scoped", async () => {
    installFetch({ savedFilter: { priorities: ["CRITICAL"] } });
    renderKanban();
    expect(await screen.findByText("Critical outage")).toBeTruthy();
    expect(screen.queryByText("Polish copy")).toBeNull();
    expect(screen.getByText(/filter this board was saved with/)).toBeTruthy();
  });

  it("a board with no saved filter shows everything and no notice", async () => {
    installFetch({});
    renderKanban();
    expect(await screen.findByText("Critical outage")).toBeTruthy();
    expect(screen.getByText("Polish copy")).toBeTruthy();
    expect(screen.queryByText(/saved with/)).toBeNull();
  });

  it("an unreadable saved filter shows nothing rather than everything, and says why", async () => {
    installFetch({ savedFilter: { priorities: ["NOT_A_PRIORITY"] } });
    const { container } = renderKanban();
    expect(await screen.findByText(/This board shows no items/)).toBeTruthy();
    // The items DID load (the loading skeleton is gone and the item request
    // was answered): they are hidden by the scope, not still in flight.
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith("/work-items"))).toBe(true),
    );
    await waitFor(() => expect(screen.getAllByText("To do").length).toBeGreaterThan(0));
    void container;
    expect(screen.queryByText("Critical outage")).toBeNull();
    expect(screen.queryByText("Polish copy")).toBeNull();
  });
});
