// @vitest-environment jsdom
//
// Sprint board tags, phase 3: "selecting multiple tags returns cards matching
// the defined logic, and the behavior is documented".
//
// The logic is OR — a card shows if it carries AT LEAST ONE of the selected
// tags. Phase 2 pinned that for two disjoint tags; what this adds is the part
// that only shows up with a richer selection (a card carrying BOTH selected
// tags, a third tag, cards that carry none) and the DOCUMENTED half: the menu
// has to say what a second tick does, because a filter that ADDS cards reads as
// a broken filter until someone tells you otherwise.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar, emptyFilters, type BoardFilters } from "./filter-bar";
import { matchesFilters, tagFilterOptions } from "@/lib/work-items/board-filters";
import { LABEL_FILTER_HINT } from "@/lib/work-items/label-filter";
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

/**
 * A sprint whose tags overlap, which is where ANY and ALL stop agreeing:
 * "Rotate" carries only API, "Tidy" only ui, and "Rewrite" carries both. Under
 * OR, picking API+ui shows all three; under AND it would show only "Rewrite".
 */
const ITEMS: WorkItem[] = [
  item({ id: "a", title: "Rotate the API keys", intervalId: SPRINT, tags: ["API"] }),
  item({ id: "b", title: "Tidy the settings page", intervalId: SPRINT, tags: ["ui"] }),
  item({ id: "c", title: "Rewrite the upload form", intervalId: SPRINT, tags: ["API", "ui"] }),
  item({ id: "d", title: "Trim the docs", intervalId: SPRINT, tags: ["docs"] }),
  item({ id: "e", title: "Nothing tagged here", intervalId: SPRINT }),
];

/** The board: the real filter bar, the real predicate, the cards it leaves. */
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

/** The Label menu, opened if it isn't already — it stays open across toggles. */
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

describe("multiple selected tags combine as OR", () => {
  it("shows a card carrying EITHER of two overlapping tags, not only the one carrying both", async () => {
    // The intersection is "Rewrite" alone. Asserting the union is what makes a
    // switch to AND fail here by name instead of quietly emptying boards.
    render(<MiniBoard />);
    await tickTag("API");
    await tickTag("ui");
    expect(visibleCards()).toEqual([
      "Rotate the API keys",
      "Tidy the settings page",
      "Rewrite the upload form",
    ]);
  });

  it("lists a card carrying both selected tags exactly once", async () => {
    // An intersection expressed as a concat instead of a filter would show
    // "Rewrite" twice — a rendering bug the union assertion above can miss.
    render(<MiniBoard />);
    await tickTag("API");
    await tickTag("ui");
    expect(visibleCards().filter((t) => t === "Rewrite the upload form")).toHaveLength(1);
  });

  it("widens the board with each extra tag rather than narrowing it", async () => {
    render(<MiniBoard />);
    await tickTag("API");
    const one = visibleCards();
    expect(one).toEqual(["Rotate the API keys", "Rewrite the upload form"]);
    await tickTag("ui");
    const two = visibleCards();
    await tickTag("docs");
    const three = visibleCards();
    // Each selection is a superset of the last — the defining property of OR.
    expect(one.every((t) => two.includes(t))).toBe(true);
    expect(two.every((t) => three.includes(t))).toBe(true);
    expect(three.length).toBeGreaterThan(two.length);
  });

  it("still excludes cards carrying none of the selected tags", async () => {
    // OR widens across the SELECTION, not across the board: an untagged card
    // and a card tagged only "docs" stay out while API+ui are the selection.
    render(<MiniBoard />);
    await tickTag("API");
    await tickTag("ui");
    expect(visibleCards()).not.toContain("Trim the docs");
    expect(visibleCards()).not.toContain("Nothing tagged here");
  });
});

describe("the tag menu documents what multiple tags do", () => {
  it("says the selection matches ANY tag, in the menu where tags are ticked", async () => {
    // Without this, the first thing a second tick does is ADD cards, which
    // reads as the filter having failed. The changelog cannot be read from here.
    const menu = await (render(<MiniBoard />), tagMenu());
    expect(within(menu).getByText(LABEL_FILTER_HINT)).toBeTruthy();
  });

  it("names the group of tag options with that sentence, so it is announced too", async () => {
    // A hint only sighted users get is half a documented behaviour. base-ui
    // wires aria-labelledby from the group to its label — the options must sit
    // INSIDE the group for the name to apply to them.
    render(<MiniBoard />);
    const menu = await tagMenu();
    const group = within(menu).getByRole("group", { name: LABEL_FILTER_HINT });
    expect(within(group).getByRole("menuitemcheckbox", { name: "API" })).toBeTruthy();
    expect(within(group).getByRole("menuitemcheckbox", { name: "ui" })).toBeTruthy();
  });

  it("keeps the hint visible while tags are selected", async () => {
    // It explains the widening, so it has to survive the moment it explains.
    render(<MiniBoard />);
    await tickTag("API");
    await tickTag("ui");
    const menu = await tagMenu();
    expect(within(menu).getByText(LABEL_FILTER_HINT)).toBeTruthy();
  });
});
