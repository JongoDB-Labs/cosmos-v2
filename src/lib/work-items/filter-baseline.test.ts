import { describe, it, expect } from "vitest";
import { activeFilterKeys, resetToBaseline } from "./filter-baseline";
import { boardBaseline, matchesFilters } from "./board-filters";
import { emptyFilters } from "@/components/boards/shared/filter-bar";
import type { BoardFilters } from "@/components/boards/shared/filter-bar";
import type { WorkItem } from "@/types/models";

/**
 * Clearing a tag filter has to give the user back the board they were looking
 * at. On a Sprint board that board is the SPRINT — so "unfiltered" cannot mean
 * the empty filter object, which would widen the view to every item in the
 * project and swap the sprint header for "No active sprint".
 */

const SPRINT = "sprint-7";

const filters = (over: Partial<BoardFilters> = {}): BoardFilters => ({
  ...emptyFilters,
  ...over,
});

/** A Sprint board's unfiltered state: scoped to its active sprint, nothing else. */
const sprintBaseline = filters({ intervalId: SPRINT });

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    orgId: "org-1",
    projectId: "proj-1",
    workItemTypeId: "t-1",
    title: "Normalise connector payloads",
    description: "",
    columnKey: "todo",
    assigneeId: null,
    priority: "MEDIUM",
    intervalId: SPRINT,
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
    createdById: "user-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as WorkItem;
}

describe("boardBaseline — what each board calls unfiltered", () => {
  it("keeps a Sprint board's sprint scope", () => {
    expect(boardBaseline(SPRINT)).toEqual(sprintBaseline);
  });

  it("is the empty filter for a board that opens showing everything", () => {
    expect(boardBaseline(undefined)).toEqual(emptyFilters);
    expect(boardBaseline(null)).toEqual(emptyFilters);
  });
});

describe("activeFilterKeys — what is actually narrowing the board", () => {
  it("reports nothing active on a pristine Sprint board", () => {
    // The sprint scope is the board, not a filter the user applied. Reporting
    // it as active is what put a "Clear" button on an untouched Sprint board
    // and forced the "More filters" row open under it.
    expect(activeFilterKeys(sprintBaseline, sprintBaseline)).toEqual([]);
  });

  it("reports the tag once one is picked, and only the tag", () => {
    const picked = filters({ intervalId: SPRINT, labels: ["api"] });
    expect(activeFilterKeys(picked, sprintBaseline)).toEqual(["labels"]);
  });

  it("still reports an interval the user moved OFF the baseline sprint", () => {
    const other = filters({ intervalId: "sprint-8" });
    expect(activeFilterKeys(other, sprintBaseline)).toEqual(["intervalId"]);
  });

  it("ignores the order tags were ticked in", () => {
    const a = filters({ labels: ["api", "ux"] });
    const b = filters({ labels: ["ux", "api"] });
    expect(activeFilterKeys(a, b)).toEqual([]);
  });

  it("does not count grouping — swimlanes hide no card", () => {
    const grouped = filters({ intervalId: SPRINT, swimlaneBy: "assignee" });
    expect(activeFilterKeys(grouped, sprintBaseline)).toEqual([]);
  });

  it("treats an empty custom-field value as unset", () => {
    // A URL round-trip can leave a key behind with no value; it filters nothing.
    const blank = filters({ customFields: { severity: "" } });
    expect(activeFilterKeys(blank, emptyFilters)).toEqual([]);
    const set = filters({ customFields: { severity: "high" } });
    expect(activeFilterKeys(set, emptyFilters)).toEqual(["customFields"]);
  });

  it("measures a plain Kanban board against the empty filter", () => {
    expect(activeFilterKeys(filters({ labels: ["api"] }), emptyFilters)).toEqual([
      "labels",
    ]);
    expect(activeFilterKeys(emptyFilters, emptyFilters)).toEqual([]);
  });
});

describe("resetToBaseline — what Clear produces", () => {
  it("drops the tag and keeps the sprint the board is showing", () => {
    const picked = filters({ intervalId: SPRINT, labels: ["api"] });
    const cleared = resetToBaseline(picked, sprintBaseline);
    expect(cleared.labels).toEqual([]);
    expect(cleared.intervalId).toBe(SPRINT);
  });

  it("leaves the grouping the user chose alone", () => {
    const picked = filters({
      intervalId: SPRINT,
      labels: ["api"],
      swimlaneBy: "assignee",
    });
    expect(resetToBaseline(picked, sprintBaseline).swimlaneBy).toBe("assignee");
  });

  it("clears every other filter too, not just the tag", () => {
    const busy = filters({
      intervalId: SPRINT,
      labels: ["api"],
      search: "payload",
      types: ["BUG"],
      priorities: ["HIGH"],
      teamId: "team-1",
      due: "overdue",
      customFields: { severity: "high" },
    });
    expect(resetToBaseline(busy, sprintBaseline)).toEqual(sprintBaseline);
  });

  it("empties the board's scope too when the board has no baseline scope", () => {
    const picked = filters({ intervalId: SPRINT, labels: ["api"] });
    expect(resetToBaseline(picked, emptyFilters).intervalId).toBeNull();
  });
});

describe("clearing restores the board that was on screen", () => {
  // The acceptance criterion, run through the predicate every board shares:
  // the set of visible cards after Clear must equal the set before filtering.
  const sprintItems = [
    item({ id: "a", tags: ["api"] }),
    item({ id: "b", tags: ["ux"] }),
    item({ id: "c", tags: [] }),
  ];
  const backlogItem = item({ id: "z", intervalId: null, tags: ["api"] });
  const all = [...sprintItems, backlogItem];

  const visible = (f: BoardFilters) =>
    all.filter((i) => matchesFilters(i, f)).map((i) => i.id);

  it("shows exactly the sprint again — no more, no less", () => {
    const before = visible(sprintBaseline);
    expect(before).toEqual(["a", "b", "c"]);

    const filtered = filters({ intervalId: SPRINT, labels: ["api"] });
    expect(visible(filtered)).toEqual(["a"]);

    // The regression this guards: resetting to `emptyFilters` here would pull
    // the backlog item "z" onto a board that never showed it.
    expect(visible(resetToBaseline(filtered, sprintBaseline))).toEqual(before);
  });

  it("unticking the last tag lands on the same board as Clear", () => {
    // The two routes out of a tag filter must agree — otherwise which one you
    // took decides which board you get back.
    const filtered = filters({ intervalId: SPRINT, labels: ["api"] });
    const untickedLast = { ...filtered, labels: [] };
    expect(visible(untickedLast)).toEqual(
      visible(resetToBaseline(filtered, sprintBaseline)),
    );
  });
});
