// @vitest-environment jsdom
//
// Sprint board tags, phase 2: "users can select one or more tags to filter the
// visible cards".
//
// This renders a board in miniature — the real FilterBar, the real
// `tagFilterOptions`, the real `matchesFilters` — because the two halves of the
// feature only meet when they are wired together. Unit tests can say which tags
// SHOULD be offered and which cards SHOULD match; only this can say that
// ticking the tag the menu offered actually changes the cards on screen.
//
// The board is scoped to a sprint (`intervalId`), which is what a SCRUM board
// is: the Kanban seeded with the active sprint. That scope is what made the
// menu lie — it was built from the project's whole item list.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar, emptyFilters, type BoardFilters } from "./filter-bar";
import { matchesFilters, tagFilterOptions } from "@/lib/work-items/board-filters";
import type { WorkItem } from "@/types/models";

// base-ui menus use pointer capture, which jsdom does not implement.
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/TEST/boards/b1",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => ({ data: undefined, isLoading: false }) };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const SPRINT = "int-1";

function item(over: Partial<WorkItem> & { id: string; title: string }): WorkItem {
  return {
    orgId: "org-1",
    projectId: "proj-1",
    workItemTypeId: "t-1",
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
  } as WorkItem;
}

/** Three in the sprint, one outside it — the card that made the menu lie. */
const ITEMS: WorkItem[] = [
  item({ id: "a", title: "Rotate the API keys", intervalId: SPRINT, tags: ["API"] }),
  item({ id: "b", title: "Tidy the settings page", intervalId: SPRINT, tags: ["ui"] }),
  item({ id: "c", title: "Nothing tagged here", intervalId: SPRINT }),
  item({ id: "d", title: "Retire the old importer", intervalId: "int-2", tags: ["legacy"] }),
];

/**
 * The board: filter bar on top, the cards it leaves visible below. Exactly the
 * two calls kanban-board makes, in the same order.
 */
function MiniBoard() {
  const [filters, setFilters] = useState<BoardFilters>({
    ...emptyFilters,
    intervalId: SPRINT,
  });
  const visible = ITEMS.filter((i) => matchesFilters(i, filters));
  return (
    <div>
      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        members={[]}
        intervals={[{ id: SPRINT, name: "Sprint 7" }] as never[]}
        teams={[]}
        orgId={ORG}
        presentLabelNames={tagFilterOptions(ITEMS, filters)}
      />
      <ul data-testid="cards">
        {visible.map((i) => (
          <li key={i.id}>{i.title}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The Label menu, opened if it isn't already. Deliberately idempotent: the menu
 * stays open across toggles (base-ui CheckboxItem), which is what makes picking
 * a SECOND tag one click rather than two — so clicking the trigger again would
 * close it. Returned so assertions can't stray out into the board below.
 */
async function tagMenu(): Promise<HTMLElement> {
  const open = screen.queryByRole("menu");
  if (open) return open;
  await userEvent.click(screen.getByRole("button", { name: /^Label/ }));
  return await screen.findByRole("menu");
}

async function tickTag(name: string) {
  const menu = await tagMenu();
  await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name }));
}

function visibleCards(): string[] {
  return within(screen.getByTestId("cards"))
    .queryAllByRole("listitem")
    .map((li) => li.textContent ?? "");
}

afterEach(cleanup);

describe("selecting tags on a sprint board", () => {
  it("shows every card in the sprint before a tag is picked", () => {
    // The baseline the rest depends on: without it, "the filter narrowed the
    // board" would pass against a board that was never showing anything.
    render(<MiniBoard />);
    expect(visibleCards()).toEqual([
      "Rotate the API keys",
      "Tidy the settings page",
      "Nothing tagged here",
    ]);
  });

  it("offers only tags that can match — not one from another sprint", async () => {
    render(<MiniBoard />);
    const menu = await tagMenu();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "API" })).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "ui" })).toBeTruthy();
    // "legacy" lives on a card in int-2. Offering it is offering an empty board.
    expect(within(menu).queryByRole("menuitemcheckbox", { name: "legacy" })).toBeNull();
  });

  it("shows a tag as the user spelt it", async () => {
    // Enum-style title-casing rendered this as "Api", so the menu entry no
    // longer read as the tag on the card it filters to.
    render(<MiniBoard />);
    const menu = await tagMenu();
    expect(within(menu).queryByText("Api")).toBeNull();
    expect(within(menu).getByText("API")).toBeTruthy();
  });

  it("narrows the board to one tag", async () => {
    render(<MiniBoard />);
    await tickTag("API");
    expect(visibleCards()).toEqual(["Rotate the API keys"]);
  });

  it("shows cards carrying EITHER tag once a second is selected", async () => {
    // The assumption this ticket was built on, asserted so that flipping it to
    // AND fails by name instead of quietly changing every board: several tags
    // combine as OR, so adding one widens the result.
    render(<MiniBoard />);
    await tickTag("API");
    await tickTag("ui");
    expect(visibleCards()).toEqual([
      "Rotate the API keys",
      "Tidy the settings page",
    ]);
    // ...and never leaks in the card from the other sprint.
    expect(visibleCards()).not.toContain("Retire the old importer");
  });

  it("still offers the second tag after the first is ticked", async () => {
    // Scoping the options to the visible cards must not include the label
    // clause itself, or the menu collapses to what is already selected and a
    // second tag becomes unselectable.
    render(<MiniBoard />);
    await tickTag("API");
    const menu = await tagMenu();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "ui" })).toBeTruthy();
  });

  it("restores the sprint's cards when the last tag is unticked", async () => {
    render(<MiniBoard />);
    await tickTag("API");
    expect(visibleCards()).toEqual(["Rotate the API keys"]);
    await tickTag("API");
    expect(visibleCards()).toEqual([
      "Rotate the API keys",
      "Tidy the settings page",
      "Nothing tagged here",
    ]);
  });
});
