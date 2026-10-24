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
        members={[]}
        onCardClick={vi.fn()}
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

describe("KanbanColumn for an archived status", () => {
  afterEach(() => cleanup());

  const renderWith = (archived?: boolean) =>
    render(
      <DndContext>
        <KanbanColumn column={makeColumn()} items={[makeItem()]} members={[]} onCardClick={() => {}} archived={archived} />
      </DndContext>,
    );

  it("marks the column and keeps its items", () => {
    renderWith(true);
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("Test card")).toBeTruthy();
  });

  it("is unmarked for a live status", () => {
    renderWith();
    expect(screen.queryByText("Archived")).toBeNull();
  });
});

// A column's title is the board's second heading level: an h2 on a flat board
// (under the page's h1), an h3 inside a swimlane (whose lane label is the h2),
// so the heading outline never skips a level (axe heading-order).
describe("KanbanColumn title heading level", () => {
  afterEach(() => {
    cleanup();
  });

  it("is an h2 by default and an h3 when the board nests it in a swimlane", () => {
    renderColumn([]);
    expect(screen.getByRole("heading", { level: 2, name: "To do" })).toBeTruthy();
    cleanup();
    render(
      <DndContext>
        <KanbanColumn column={makeColumn()} items={[]} members={[]} onCardClick={vi.fn()} headingLevel={3} />
      </DndContext>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "To do" })).toBeTruthy();
  });
});

describe("KanbanColumn while a card that can't move here is dragged", () => {
  afterEach(() => cleanup());

  it("is dimmed and says why, and is otherwise left alone", () => {
    const { container, rerender } = render(
      <DndContext>
        <KanbanColumn column={makeColumn()} items={[]} members={[]} onCardClick={() => {}} unavailable />
      </DndContext>,
    );
    const col = container.querySelector("[data-board-column='todo']")!;
    expect(col.getAttribute("data-unavailable")).toBe("true");
    expect(col.className).toContain("opacity-40");
    expect(col.getAttribute("title")).toMatch(/workflow doesn't allow/);

    rerender(
      <DndContext>
        <KanbanColumn column={makeColumn()} items={[]} members={[]} onCardClick={() => {}} />
      </DndContext>,
    );
    expect(col.hasAttribute("data-unavailable")).toBe(false);
    expect(col.className).not.toContain("opacity-40");
  });
});
