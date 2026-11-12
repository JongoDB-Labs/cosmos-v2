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

// The card is a role=button named by its content, so its name always contains
// the title, in and out of select mode.
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

  it("outside select mode the card is a plain button, not a selection toggle", () => {
    renderCard();
    expect(getCard()).not.toHaveAttribute("aria-pressed");
  });
});

// WCAG 2.5.3 Label in Name (axe `label-content-name-mismatch`). The card was
// named by an aria-label, "Open #42: Test card", while it SHOWS the key, the
// title, the type chip, the points and the assignee's initial. A name that
// leaves out visible text fails speech input ("click Story" matches nothing)
// and hid everything but the title from a screen reader.
//
// axe itself cannot judge this here: jsdom has no layout, so axe reports the
// rule "incomplete" for the old card and the new one alike. These tests state
// the same containment directly, against the name testing-library computes.
describe("KanbanCard accessible name contains its visible text (WCAG 2.5.3)", () => {
  afterEach(() => {
    cleanup();
  });

  const ADA = {
    id: "m1",
    userId: "u-ada",
    user: { id: "u-ada", displayName: "Ada Lovelace", avatarUrl: null },
  } as unknown as OrgMember;
  const FULL = makeItem({
    title: "Fix the login",
    storyPoints: 5,
    assigneeId: "u-ada",
    workItemType: { name: "Story" },
  } as Partial<WorkItem>);

  /** Letters and digits only, lowercased: spacing and punctuation don't count. */
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  /** The card, its computed accessible name, and the text it shows. */
  function nameAndText() {
    let name = "";
    const card = screen.getByRole("button", {
      name: (computed) => {
        if (!computed.includes("Fix the login")) return false;
        name = computed;
        return true;
      },
    });
    return { card, name, text: card.textContent ?? "" };
  }

  it("names the card by everything it shows", () => {
    renderCard({ item: FULL, members: [ADA] });
    const { name, text } = nameAndText();
    // Positive control: the card really shows the extra chips, so this is
    // more than the title being found in itself.
    for (const shown of ["#42", "Fix the login", "Story", "5", "A"]) {
      expect(text).toContain(shown);
    }
    expect(squash(name)).toContain(squash(text));
  });

  it("leads with the key and the title, the words a person reads and says", () => {
    renderCard({ item: FULL, members: [ADA] });
    expect(squash(nameAndText().name).startsWith(squash("#42 Fix the login"))).toBe(true);
  });

  it("is named by its content in select mode too, with the state in aria-pressed", () => {
    for (const selected of [false, true]) {
      renderCard({ item: FULL, members: [ADA], selectMode: true, selected });
      const { card, name, text } = nameAndText();
      expect(card).not.toHaveAttribute("aria-label");
      expect(card).toHaveAttribute("aria-pressed", String(selected));
      expect(squash(name)).toContain(squash(text));
      cleanup();
    }
  });
});

// A card's title sits one level below its column's (axe heading-order): h3 on a
// flat board's h2 column, h4 in a swimlane, whose columns are h3.
describe("KanbanCard title heading level", () => {
  afterEach(() => {
    cleanup();
  });

  it("is an h3 by default and an h4 when its column is nested in a swimlane", () => {
    renderCard();
    expect(screen.getByRole("heading", { level: 3, name: "Test card" })).toBeTruthy();
    cleanup();
    renderCard({ headingLevel: 4 });
    expect(screen.getByRole("heading", { level: 4, name: "Test card" })).toBeTruthy();
  });
});
