// @vitest-environment jsdom
// A horizontally scrollable region has to be focusable, or its off-screen
// content cannot be reached without a pointer (axe `scrollable-region-focusable`,
// WCAG 2.1.1).
//
// The Kanban column strip was not. On a board WITH cards the rule is satisfied
// incidentally -- you tab to a card and the strip scrolls it into view -- so the
// gap only bites on an EMPTY board, where the strip measured scrollWidth 1520
// against clientWidth 1024 with nothing focusable in it at all. The later
// columns' names were unreachable by keyboard.
//
// This went unnoticed because the a11y e2e scan was reporting clean on a
// LOADING SKELETON: its wait was `.first().waitFor({state:"detached"}).catch(()
// => {})`, which waited for one skeleton and swallowed the timeout. Fixed in the
// same change as this. jsdom computes no layout, so this spec asserts
// focusability -- the property the rule is about -- and not the overflow.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

const COLUMNS = [
  { id: "c1", key: "todo", name: "To do", sortOrder: 0, category: "TODO" },
  { id: "c2", key: "doing", name: "Doing", sortOrder: 1, category: "IN_PROGRESS" },
  { id: "c3", key: "done", name: "Done", sortOrder: 2, category: "DONE" },
];

/** `items` is what `/work-items` returns — [] is the case that bites. */
function installFetch(items: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/boards/b1")
        ? { id: "b1", name: "Board", type: "KANBAN", config: {}, columns: COLUMNS }
        : url.endsWith("/work-items")
          ? items
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

/** The horizontally scrollable column strip. */
const strips = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[class*="overflow-x-auto"]'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Kanban column strip is keyboard-reachable", () => {
  it("renders a column strip at all", async () => {
    // Positive control: every assertion below queries that element, so if the
    // board failed to render they would pass over an empty list.
    installFetch([]);
    const { container } = renderKanban();
    await screen.findAllByText("To do");
    expect(strips(container).length).toBeGreaterThan(0);
  });

  it("is focusable on an empty board, where nothing else is", async () => {
    installFetch([]);
    const { container } = renderKanban();
    await screen.findAllByText("To do");
    for (const s of strips(container)) {
      expect(s.getAttribute("tabindex")).toBe("0");
    }
  });

  it("says what it is when focused", async () => {
    // A bare tab stop that announces nothing is its own problem.
    installFetch([]);
    const { container } = renderKanban();
    await screen.findAllByText("To do");
    for (const s of strips(container)) {
      expect((s.getAttribute("aria-label") ?? "").trim()).not.toBe("");
    }
  });

  it("is still focusable with cards present", async () => {
    // The rule passes incidentally here (cards are tabbable), which is exactly
    // why the empty case went unnoticed -- so pin both.
    installFetch([
      {
        id: "i1", orgId: "o1", projectId: "p1", workItemTypeId: "t1", title: "A card",
        description: "", columnKey: "todo", priority: "MEDIUM", assigneeId: null,
        assignees: [], parentId: null, intervalId: null, ticketNumber: 1, tags: [],
        customFields: {}, archivedAt: null, startDate: null, dueDate: null,
        completedAt: null, storyPoints: null,
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
        workItemType: { id: "t1", key: "task", name: "Task", icon: null, color: null },
      },
    ]);
    const { container } = renderKanban();
    await screen.findByText("A card");
    for (const s of strips(container)) {
      expect(s.getAttribute("tabindex")).toBe("0");
    }
  });
});
