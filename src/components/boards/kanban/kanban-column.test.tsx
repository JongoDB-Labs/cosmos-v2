// @vitest-environment jsdom
//
// COSMOS-133 — "show a muted placeholder in empty Kanban board columns".
// An empty column must render a small muted "No items" placeholder so it does
// not look broken; a column that has cards must NOT render the placeholder.
// This locks that behavior against regressions.
//
// The card is stubbed so this suite exercises only the column's empty-state
// branch without dragging in card-level providers (permissions / react-query).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { KanbanColumn } from "./kanban-column";
import type { BoardColumn, WorkItem } from "@/types/models";

vi.mock("./kanban-card", () => ({
  KanbanCard: ({ item }: { item: WorkItem }) => <div>{item.title}</div>,
}));

// dnd-kit needs ResizeObserver in jsdom (see kanban-card.test.tsx).
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function makeColumn(overrides: Partial<BoardColumn> = {}): BoardColumn {
  return {
    id: "c1",
    boardId: "b1",
    name: "To do",
    key: "todo",
    color: "#8888ff",
    wipLimit: null,
    sortOrder: 0,
    category: "TODO",
    ...overrides,
  };
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1",
    orgId: "o1",
    projectId: "p1",
    workItemTypeId: "t1",
    title: "Test card",
    description: "",
    columnKey: "todo",
    assigneeId: null,
    priority: "MEDIUM",
    intervalId: null,
    parentId: null,
    ticketNumber: 42,
    storyPoints: null,
    sortOrder: 0,
    dueDate: null,
    startDate: null,
    actualStart: null,
    completedAt: null,
    workCategory: "BUSINESS",
    tags: [],
    customFields: {},
    createdById: "u1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderColumn(items: WorkItem[]) {
  return render(
    <DndContext>
      <KanbanColumn
        column={makeColumn()}
        items={items}
        orgId="o1"
        projectId="p1"
        projectKey="FSC"
        members={[]}
        onCardClick={vi.fn()}
        onCardCreated={vi.fn()}
        // Skip the per-column quick-create so the test needs no
        // permissions/query providers — we only assert the empty state.
        hideQuickCreate
      />
    </DndContext>,
  );
}

describe("KanbanColumn empty-state placeholder (COSMOS-133)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a muted 'No items' placeholder when the column has zero cards", () => {
    renderColumn([]);

    const placeholder = screen.getByText("No items");
    expect(placeholder).toBeInTheDocument();
    // Muted + centered, consistent with existing tokens.
    expect(placeholder.className).toContain("text-muted-foreground");
    expect(placeholder.className).toContain("justify-center");
  });

  it("does not render the placeholder when the column has cards", () => {
    renderColumn([makeItem()]);

    expect(screen.queryByText("No items")).not.toBeInTheDocument();
    expect(screen.getByText("Test card")).toBeInTheDocument();
  });
});
