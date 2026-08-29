// @vitest-environment jsdom
//
// Sprint board tags, phase 1: "the sprint board provides a tag filter control
// that lists available tags".
//
// The unit tests next door can say which tags `tagFilterOptions` SHOULD return.
// Only this can say that a control actually exists on the board, that opening it
// shows those tags, and that they read as the user spelt them — three separate
// ways the criterion fails while the derivation is perfectly correct.
//
// The board is scoped to a sprint (`intervalId`), which is what a SCRUM board
// is: the Kanban seeded with the active sprint via `initialIntervalId`. That
// scope is what made the list wrong — it was built from the project's whole
// item list, so it offered tags no card on this board carries.
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

/** Three cards in the sprint, one outside it — the card that made the list lie. */
const ITEMS: WorkItem[] = [
  item({ id: "a", title: "Rotate the API keys", intervalId: SPRINT, tags: ["API"] }),
  item({ id: "b", title: "Tidy the settings page", intervalId: SPRINT, tags: ["ui"] }),
  item({ id: "c", title: "Nothing tagged here", intervalId: SPRINT }),
  item({ id: "d", title: "Retire the old importer", intervalId: "int-2", tags: ["legacy"] }),
];

/**
 * The board in miniature: the real filter bar over the real derivation, above
 * the cards the real predicate leaves visible. Exactly the two calls
 * kanban-board makes, in the same order.
 */
function MiniBoard({ items = ITEMS }: { items?: WorkItem[] } = {}) {
  const [filters, setFilters] = useState<BoardFilters>({
    ...emptyFilters,
    intervalId: SPRINT,
  });
  const visible = items.filter((i) => matchesFilters(i, filters));
  return (
    <div>
      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        members={[]}
        intervals={[{ id: SPRINT, name: "Sprint 7" }] as never[]}
        teams={[]}
        orgId={ORG}
        presentLabelNames={tagFilterOptions(items, filters)}
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
 * The tag control's menu, opened if it isn't already. Idempotent because the
 * menu stays open across toggles (base-ui CheckboxItem) — clicking the trigger
 * a second time would close it. Returned so assertions can't stray out into the
 * board below.
 */
async function tagMenu(): Promise<HTMLElement> {
  const open = screen.queryByRole("menu");
  if (open) return open;
  await userEvent.click(screen.getByRole("button", { name: /^Label/ }));
  return await screen.findByRole("menu");
}

function listedTags(menu: HTMLElement): string[] {
  return within(menu)
    .queryAllByRole("menuitemcheckbox")
    .map((el) => el.textContent ?? "");
}

afterEach(cleanup);

describe("the sprint board's tag filter control", () => {
  it("is on the board", () => {
    // The criterion's first half. A control that exists but lists the wrong
    // tags and a control that is absent are different failures.
    render(<MiniBoard />);
    expect(screen.getByRole("button", { name: /^Label/ })).toBeTruthy();
  });

  it("lists the tags available on the sprint's cards", async () => {
    render(<MiniBoard />);
    expect(listedTags(await tagMenu())).toEqual(["API", "ui"]);
  });

  it("does not list a tag carried only by a card in another sprint", async () => {
    // "legacy" lives on a card in int-2, which this board never shows. Listing
    // it is offering an empty board with the reason invisible.
    render(<MiniBoard />);
    expect(
      within(await tagMenu()).queryByRole("menuitemcheckbox", { name: "legacy" }),
    ).toBeNull();
  });

  it("lists a tag as the user spelt it", async () => {
    // Enum-style title-casing rendered this as "Api", so the entry no longer
    // read as the tag on the card it filters to.
    const menu = (render(<MiniBoard />), await tagMenu());
    expect(within(menu).queryByText("Api")).toBeNull();
    expect(within(menu).getByText("API")).toBeTruthy();
  });

  it("still lists the other tag once one is picked", async () => {
    // Scoping the list to the visible cards must not apply the tag clause
    // itself, or the menu collapses to what is already ticked and a second tag
    // becomes unselectable.
    render(<MiniBoard />);
    await userEvent.click(
      within(await tagMenu()).getByRole("menuitemcheckbox", { name: "API" }),
    );
    expect(listedTags(await tagMenu())).toEqual(["API", "ui"]);
  });

  it("shows the cards carrying a picked tag, and only those", async () => {
    // The assumption this was built on, asserted so flipping it fails by name:
    // picking a tag shows the cards carrying it, and picking none filters
    // nothing.
    render(<MiniBoard />);
    const cards = () =>
      within(screen.getByTestId("cards"))
        .queryAllByRole("listitem")
        .map((li) => li.textContent ?? "");
    expect(cards()).toEqual([
      "Rotate the API keys",
      "Tidy the settings page",
      "Nothing tagged here",
    ]);
    await userEvent.click(
      within(await tagMenu()).getByRole("menuitemcheckbox", { name: "API" }),
    );
    expect(cards()).toEqual(["Rotate the API keys"]);
  });

  it("hides the control when no card on the board is tagged", () => {
    // Nothing available to list, so no dead control — and no empty menu for a
    // user to open and learn nothing from.
    render(<MiniBoard items={[item({ id: "c", title: "Untagged", intervalId: SPRINT })]} />);
    expect(screen.queryByRole("button", { name: /^Label/ })).toBeNull();
  });
});
