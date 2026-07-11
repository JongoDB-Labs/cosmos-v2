// @vitest-environment jsdom
//
// COSMOS-52 — "hold Ctrl/Cmd to select multiple cards (activates bulk select)".
// The interaction itself already shipped (bulk multi-select 2.73.0, Ctrl/Cmd-click
// entry 2.81.1, shift-click range COSMOS-39/2.186.0) but had NO automated coverage.
// This locks the card-level click routing against regressions, mapping 1:1 to the
// ticket's acceptance criteria:
//   1. Ctrl (Win/Linux) or Cmd (macOS) + click adds the card to the selection
//      (→ onCtrlSelect) without opening it.
//   2/3. In select mode the card is a checkbox toggle with a clear selected
//      indication (aria-pressed + the check glyph + highlight ring).
//   4. A plain click (no modifier, not in select mode) opens the card only — it
//      never silently accretes a hidden selection.
// It also guards the shift-click range path so it keeps taking priority over the
// open/toggle branches whether or not select mode is already on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { KanbanCard } from "./kanban-card";
import type { WorkItem, OrgMember } from "@/types/models";

// --- base-ui / dnd-kit need these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// useOrgMutation → useOrgSlug reads the pathname; give it a stable org URL.
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
}));

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
    cycleId: null,
    parentId: null,
    ticketNumber: 42,
    storyPoints: null,
    sortOrder: 0,
    dueDate: null,
    startDate: null,
    baselineStart: null,
    baselineEnd: null,
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

type CardProps = Parameters<typeof KanbanCard>[0];

function renderCard(props: Partial<CardProps> = {}) {
  const item = props.item ?? makeItem();
  const members: OrgMember[] = props.members ?? [];
  const handlers = {
    onClick: vi.fn(),
    onToggleSelect: vi.fn(),
    onCtrlSelect: vi.fn(),
    onRangeSelect: vi.fn(),
    ...props,
  } as CardProps;

  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DndContext>
        <SortableContext items={[item.id]}>
          <KanbanCard {...handlers} item={item} members={members} />
        </SortableContext>
      </DndContext>
    </QueryClientProvider>,
  );

  return handlers;
}

// The card is a role=button; its accessible name always contains the title, so
// this matches whether it reads "Open …", "Select …", or "Deselect …".
const getCard = () => screen.getByRole("button", { name: /Test card/ });

describe("KanbanCard click routing (COSMOS-52)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("Ctrl-click (Windows/Linux) adds the card to the selection without opening it", () => {
    const h = renderCard();
    fireEvent.click(getCard(), { ctrlKey: true });

    expect(h.onCtrlSelect).toHaveBeenCalledWith("w1");
    expect(h.onClick).not.toHaveBeenCalled();
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it("Cmd-click (macOS) adds the card to the selection without opening it", () => {
    const h = renderCard();
    fireEvent.click(getCard(), { metaKey: true });

    expect(h.onCtrlSelect).toHaveBeenCalledWith("w1");
    expect(h.onClick).not.toHaveBeenCalled();
  });

  it("a plain click (no modifier) opens the card and never accretes a selection", () => {
    const h = renderCard();
    fireEvent.click(getCard());

    expect(h.onClick).toHaveBeenCalledTimes(1);
    expect(h.onClick).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }));
    expect(h.onCtrlSelect).not.toHaveBeenCalled();
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it("shift-click takes the range path instead of opening the card", () => {
    const h = renderCard();
    fireEvent.click(getCard(), { shiftKey: true });

    expect(h.onRangeSelect).toHaveBeenCalledWith("w1");
    expect(h.onClick).not.toHaveBeenCalled();
  });

  it("in select mode a plain click toggles the card (checkbox behavior), not open", () => {
    const h = renderCard({ selectMode: true });
    fireEvent.click(getCard());

    expect(h.onToggleSelect).toHaveBeenCalledWith("w1");
    expect(h.onClick).not.toHaveBeenCalled();
    expect(h.onCtrlSelect).not.toHaveBeenCalled();
  });

  it("in select mode shift-click still ranges rather than toggling a single card", () => {
    const h = renderCard({ selectMode: true });
    fireEvent.click(getCard(), { shiftKey: true });

    expect(h.onRangeSelect).toHaveBeenCalledWith("w1");
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it("a selected card shows a clear visual indication (aria-pressed + check glyph)", () => {
    renderCard({ selectMode: true, selected: true });
    const card = getCard();

    expect(card).toHaveAttribute("aria-pressed", "true");
    // The highlight ring marks the selected state visually.
    expect(card.className).toContain("border-primary");
    // The checkbox affordance renders a check glyph only when selected.
    expect(card.querySelector("svg")).not.toBeNull();
  });

  it("an unselected card in select mode is not marked pressed and shows no check", () => {
    renderCard({ selectMode: true, selected: false });
    const card = getCard();

    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(card.querySelector("svg")).toBeNull();
  });

  it("outside select mode the card advertises Open, not a selection toggle", () => {
    renderCard();
    expect(
      screen.getByRole("button", { name: /^Open .*Test card/ }),
    ).toBeInTheDocument();
  });
});
