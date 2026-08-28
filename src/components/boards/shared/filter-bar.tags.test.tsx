// @vitest-environment jsdom
//
// COSMOS-179 — selecting one or more tags filters the visible cards.
//
// The board wiring in miniature: the filter bar's tag menu is fed by
// `tagFilterOptions`, and the cards are narrowed by `matchesFilters` — exactly
// how kanban-board.tsx composes them. Testing the pieces separately proved the
// predicate and the option list in isolation while saying nothing about the one
// thing a user does: open the menu, tick two tags, and watch the board narrow.
//
// SEMANTICS, stated because they were the open question on this ticket: ticking
// several tags is OR — a card is visible if it carries ANY of them. That matches
// how Type and Priority already behave, and how the tag filter has behaved since
// it shipped. "Has both" is a different question and would need its own control.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilterBar, emptyFilters, type BoardFilters } from "./filter-bar";
import { matchesFilters, tagFilterOptions } from "@/lib/work-items/board-filters";
import type { WorkItem } from "@/types/models";

// --- base-ui needs these in jsdom (same shims as action-menu.test.tsx) ---
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/TEST/boards/b1",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => ({ data: undefined, isLoading: false }) };
});

const ORG = "11111111-1111-4111-8111-111111111111";

function card(over: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-1",
    orgId: "org-1",
    projectId: "proj-1",
    workItemTypeId: "t-1",
    title: "Card",
    description: "",
    columnKey: "todo",
    assigneeId: null,
    priority: "MEDIUM",
    intervalId: null,
    parentId: null,
    ticketNumber: 1,
    storyPoints: null,
    sortOrder: 0,
    dueDate: null,
    startDate: null,
    actualStart: null,
    completedAt: null,
    workCategory: "BUSINESS",
    tags: [],
    customFields: {},
    createdById: "user-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// A sprint board's situation: the project's whole item list is loaded, the board
// is scoped to the active sprint, and two of the four cards sit outside it.
const SPRINT = "s-7";
const CARDS: WorkItem[] = [
  card({ id: "a", title: "Rate limiter", intervalId: SPRINT, tags: ["api"] }),
  card({ id: "b", title: "Empty states", intervalId: SPRINT, tags: ["ui"] }),
  card({ id: "c", title: "Audit trail", intervalId: SPRINT, tags: ["api", "ui"] }),
  card({ id: "d", title: "Old migration", intervalId: "s-3", tags: ["legacy"] }),
];

/** The board, reduced to a filter bar over a list of card titles. */
function Board({ initial }: { initial?: Partial<BoardFilters> }) {
  const [filters, setFilters] = useState<BoardFilters>({
    ...emptyFilters,
    ...initial,
  });
  const visible = CARDS.filter((c) => matchesFilters(c, filters));
  return (
    <>
      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        members={[]}
        intervals={[]}
        orgId={ORG}
        presentLabelNames={tagFilterOptions(CARDS, filters)}
      />
      <ul>
        {visible.map((c) => (
          <li key={c.id}>{c.title}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * Open the tag menu if it isn't already — ticking an option deliberately leaves
 * it open (that's what makes picking a second tag one click rather than three),
 * so clicking the trigger again would close it.
 */
async function openTagMenu() {
  const trigger = screen.getByRole("button", { name: /^label/i });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  // The popup mounts a tick late.
  return screen.findAllByRole("menuitemcheckbox");
}

async function pickTag(name: string) {
  await openTagMenu();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
}

/** The tags the menu is offering. */
async function offeredTags() {
  return (await openTagMenu()).map((el) => el.textContent);
}

const titles = () => screen.getAllByRole("listitem").map((li) => li.textContent);

afterEach(cleanup);

describe("filtering the board by tag", () => {
  it("shows every card before a tag is picked", () => {
    // The baseline: without it, every "is hidden" assertion below could pass
    // against a board that renders nothing at all.
    render(<Board />);
    expect(titles()).toEqual([
      "Rate limiter",
      "Empty states",
      "Audit trail",
      "Old migration",
    ]);
  });

  it("narrows to the cards carrying the picked tag", async () => {
    render(<Board />);
    await pickTag("api");
    expect(titles()).toEqual(["Rate limiter", "Audit trail"]);
  });

  it("WIDENS to the union when a second tag is picked, not the intersection", async () => {
    render(<Board />);
    await pickTag("api");
    await pickTag("ui");
    // OR: "Empty states" carries only `ui` and must come back into view. Under
    // AND semantics only "Audit trail" (which has both) would survive.
    expect(titles()).toEqual(["Rate limiter", "Empty states", "Audit trail"]);
  });

  it("keeps the menu open after a tick, so the second tag is one more click", async () => {
    render(<Board />);
    await pickTag("api");
    expect(
      screen.getByRole("button", { name: /^label/i }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("restores the whole board when the last tag is unpicked", async () => {
    render(<Board />);
    await pickTag("api");
    expect(titles()).toHaveLength(2);
    await pickTag("api");
    expect(titles()).toHaveLength(4);
  });
});

describe("which tags the menu offers", () => {
  it("offers only tags carried by cards the board is showing", async () => {
    // Scoped to the sprint, `legacy` belongs to a card in another one: offering
    // it would be a dead end that empties the board.
    render(<Board initial={{ intervalId: SPRINT }} />);
    expect(await offeredTags()).toEqual(["api", "ui"]);
  });

  it("still offers the others once one is picked, so a second can be added", async () => {
    render(<Board initial={{ intervalId: SPRINT }} />);
    await pickTag("api");
    expect(await offeredTags()).toEqual(["api", "ui"]);
  });

  it("shows a tag under the name it was given, not title-cased", async () => {
    // "API" must not be offered as "Api": the menu entry has to be the label as
    // the org spelt it, or it reads as a different tag from the one on the card.
    render(
      <FilterBar
        filters={emptyFilters}
        onFilterChange={() => {}}
        members={[]}
        intervals={[]}
        orgId={ORG}
        presentLabelNames={["API", "needs-QA"]}
      />,
    );
    expect(await offeredTags()).toEqual(["API", "needs-QA"]);
  });
});
