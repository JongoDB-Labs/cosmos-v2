// @vitest-environment jsdom
//
// While cards shift during a sort, each card's ⋯ menu moves with it. The ⋯ is
// a sibling of the card inside the hover box (ActionMenu renders it so), so the
// sort's transform belongs on that box, as RAID's cards have it. On the card
// alone, the card slid away and its ⋯ stayed behind.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkItem } from "@/types/models";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/FSC/boards/b1" }));
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return { ...real, usePermissions: () => ({ orgId: "o1", orgSlug: "acme", role: "ADMIN", permissions: ~0n, can: () => true }) };
});
// Mid-sort: dnd-kit has moved this card 40px down to make room for another.
const sortable = vi.hoisted(() => ({ setNodeRef: vi.fn() }));
vi.mock("@dnd-kit/sortable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/sortable")>()),
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0 },
    listeners: {},
    setNodeRef: sortable.setNodeRef,
    transform: { x: 0, y: 40, scaleX: 1, scaleY: 1 },
    transition: "transform 200ms ease",
    isDragging: false,
  }),
}));

import { KanbanCard } from "./kanban-card";

const item = {
  id: "w1", orgId: "o1", projectId: "p1", workItemTypeId: "t1", title: "Sorting card", description: "", columnKey: "todo",
  assigneeId: null, priority: "MEDIUM", intervalId: null, parentId: null, ticketNumber: 42, storyPoints: null, sortOrder: 0,
  dueDate: null, startDate: null, actualStart: null, completedAt: null, workCategory: "BUSINESS", tags: [], customFields: {},
  createdById: "u1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
} as WorkItem;

describe("a kanban card's ⋯ moves with it during a sort", () => {
  afterEach(cleanup);

  it("puts the sort's transform, and dnd-kit's node, on the box that holds the card and its ⋯", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KanbanCard item={item} members={[]} onClick={vi.fn()} />
      </QueryClientProvider>,
    );
    const trigger = screen.getByRole("button", { name: /open menu/i });
    const card = screen.getByTestId("kanban-card-w1");
    const box = trigger.closest(".group\\/action") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.contains(card)).toBe(true); // the box holds both
    expect(box.style.transform).toBe("translate3d(0px, 40px, 0) scaleX(1) scaleY(1)");
    expect(box.style.transition).toBe("transform 200ms ease");
    expect(card.style.transform).toBe(""); // not moved twice
    expect(sortable.setNodeRef).toHaveBeenCalledWith(box); // dnd-kit measures what moves
  });
});
