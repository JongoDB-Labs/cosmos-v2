import { describe, it, expect } from "vitest";
import { matchesFilters } from "./board-filters";
import { NO_ESTIMATE } from "./relation-filters";
import { teamsByUser } from "@/lib/teams/item-teams";
import { emptyFilters } from "@/components/boards/shared/filter-bar";
import type { BoardFilters } from "@/components/boards/shared/filter-bar";
import type { WorkItem, CustomField } from "@/types/models";

/**
 * THE filter predicate — seven board types now share it (Kanban, Timeline,
 * Calendar, RAID, Roadmap, Backlog, Table), and until this file it had no tests
 * of its own. A regression here silently changes what every board shows.
 *
 * Each clause is tested as a PAIR: an item the filter must keep and one it must
 * drop. Asserting only the exclusion would pass against a predicate that
 * returned false for everything, which is the failure mode that looks most like
 * working filtering — an empty board reads as "nothing matched".
 */

const NOW = new Date("2026-08-12T12:00:00.000Z");

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
    createdById: "user-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

const filters = (over: Partial<BoardFilters> = {}): BoardFilters => ({
  ...emptyFilters,
  ...over,
});

describe("matchesFilters — the pristine board", () => {
  it("keeps every item when no filter is set", () => {
    // The baseline the rest of the file depends on: if this were false, every
    // "is excluded" assertion below would pass for the wrong reason.
    expect(matchesFilters(item(), filters())).toBe(true);
  });

  it("keeps an item that carries none of the optional data", () => {
    // No assignees array, no type, no tags, no custom fields. A predicate that
    // assumed any of these were present would drop real items.
    expect(matchesFilters(item({ tags: [], workItemType: undefined }), filters())).toBe(
      true,
    );
  });
});

describe("search", () => {
  it("matches the title case-insensitively", () => {
    expect(matchesFilters(item(), filters({ search: "CONNECTOR" }))).toBe(true);
  });

  it("drops an item whose title does not contain the term", () => {
    expect(matchesFilters(item(), filters({ search: "nonexistent" }))).toBe(false);
  });

  it("matches on ticket number, so a board can be searched by ID", () => {
    expect(matchesFilters(item({ ticketNumber: 42 }), filters({ search: "42" }))).toBe(
      true,
    );
    expect(matchesFilters(item({ ticketNumber: 42 }), filters({ search: "43" }))).toBe(
      false,
    );
  });
});

describe("type", () => {
  const bug = item({
    workItemType: { id: "t", key: "software.BUG", name: "Bug", icon: null, color: null },
  });

  it("matches on the bare key, ignoring the namespace prefix", () => {
    // Keys arrive namespaced ("software.BUG"); the filter stores "BUG".
    expect(matchesFilters(bug, filters({ types: ["BUG"] }))).toBe(true);
  });

  it("drops an item of another type", () => {
    expect(matchesFilters(bug, filters({ types: ["TASK"] }))).toBe(false);
  });

  it("keeps an item matching ANY of several selected types", () => {
    expect(matchesFilters(bug, filters({ types: ["TASK", "BUG"] }))).toBe(true);
  });
});

describe("priority", () => {
  it("keeps a matching priority and drops the rest", () => {
    expect(matchesFilters(item({ priority: "HIGH" }), filters({ priorities: ["HIGH"] }))).toBe(true);
    expect(matchesFilters(item({ priority: "LOW" }), filters({ priorities: ["HIGH"] }))).toBe(false);
  });
});

describe("assignee", () => {
  it("matches the primary assignee", () => {
    expect(matchesFilters(item({ assigneeId: "u-1" }), filters({ assigneeId: "u-1" }))).toBe(true);
  });

  it("matches a SECONDARY assignee, not only the owner", () => {
    // Multi-assign: filtering to someone must not hide work they share.
    const shared = item({ assigneeId: "u-1", assignees: [{ userId: "u-1" }, { userId: "u-2" }] });
    expect(matchesFilters(shared, filters({ assigneeId: "u-2" }))).toBe(true);
  });

  it("drops an item nobody relevant is on", () => {
    const shared = item({ assigneeId: "u-1", assignees: [{ userId: "u-1" }] });
    expect(matchesFilters(shared, filters({ assigneeId: "u-9" }))).toBe(false);
  });
});

describe("interval, status, work category and reporter", () => {
  it("filters by interval", () => {
    expect(matchesFilters(item({ intervalId: "s-1" }), filters({ intervalId: "s-1" }))).toBe(true);
    expect(matchesFilters(item({ intervalId: "s-2" }), filters({ intervalId: "s-1" }))).toBe(false);
  });

  it("filters by column key (status)", () => {
    expect(matchesFilters(item({ columnKey: "done" }), filters({ columnKeys: ["done"] }))).toBe(true);
    expect(matchesFilters(item({ columnKey: "todo" }), filters({ columnKeys: ["done"] }))).toBe(false);
  });

  it("filters by work category", () => {
    expect(matchesFilters(item({ workCategory: "ENABLER" }), filters({ workCategories: ["ENABLER"] }))).toBe(true);
    expect(matchesFilters(item({ workCategory: "BUSINESS" }), filters({ workCategories: ["ENABLER"] }))).toBe(false);
  });

  it("filters by who raised it", () => {
    expect(matchesFilters(item({ createdById: "u-1" }), filters({ createdById: "u-1" }))).toBe(true);
    expect(matchesFilters(item({ createdById: "u-2" }), filters({ createdById: "u-1" }))).toBe(false);
  });
});

describe("labels", () => {
  it("keeps an item carrying ANY selected label", () => {
    // Unlike Type, an item has many labels, so this is an intersection.
    const tagged = item({ tags: ["risk", "ui"] });
    expect(matchesFilters(tagged, filters({ labels: ["ui"] }))).toBe(true);
    expect(matchesFilters(tagged, filters({ labels: ["backend", "ui"] }))).toBe(true);
  });

  it("drops an item carrying none of them", () => {
    expect(matchesFilters(item({ tags: ["risk"] }), filters({ labels: ["ui"] }))).toBe(false);
  });
});

describe("team", () => {
  // A team's work is what its members are assigned; items carry no team.
  // Built through `teamsByUser`, the same call the boards make, rather than a
  // hand-rolled Map — the first draft hand-rolled one without `members`, which
  // typechecked only because the test cast it away and passed only because
  // `itemMatchesTeam` happens to read `id` alone today.
  const roster = teamsByUser([
    { id: "team-a", name: "A", members: [{ userId: "u-1" }] },
  ]);

  it("keeps work assigned to a member of the chosen team", () => {
    expect(
      matchesFilters(item({ assigneeId: "u-1" }), filters({ teamId: "team-a" }), [], roster),
    ).toBe(true);
  });

  it("drops work assigned to someone outside it", () => {
    expect(
      matchesFilters(item({ assigneeId: "u-9" }), filters({ teamId: "team-a" }), [], roster),
    ).toBe(false);
  });

  it("is INERT when no roster is supplied rather than hiding everything", () => {
    // The roster is an optional argument. A board that does not load teams must
    // still show its work — silently emptying is the worse failure.
    expect(matchesFilters(item({ assigneeId: "u-1" }), filters())).toBe(true);
  });
});

describe("due-date preset", () => {
  it("keeps work due inside the next week", () => {
    const soon = item({ dueDate: "2026-08-14T12:00:00.000Z" });
    expect(matchesFilters(soon, filters({ due: "week" }), [], new Map(), NOW)).toBe(true);
  });

  it("drops work due beyond the horizon", () => {
    const later = item({ dueDate: "2026-09-30T12:00:00.000Z" });
    expect(matchesFilters(later, filters({ due: "week" }), [], new Map(), NOW)).toBe(false);
  });

  it("finds overdue work", () => {
    const late = item({ dueDate: "2026-08-01T12:00:00.000Z" });
    expect(matchesFilters(late, filters({ due: "overdue" }), [], new Map(), NOW)).toBe(true);
    expect(matchesFilters(late, filters({ due: "none" }), [], new Map(), NOW)).toBe(false);
  });

  it("treats an item with no due date as 'none'", () => {
    expect(matchesFilters(item(), filters({ due: "none" }), [], new Map(), NOW)).toBe(true);
    expect(matchesFilters(item(), filters({ due: "overdue" }), [], new Map(), NOW)).toBe(false);
  });
});

describe("relation-derived filters", () => {
  it("filters to blocked work from the caller's resolved set", () => {
    const rel = { blocked: new Set(["wi-1"]) };
    expect(matchesFilters(item({ id: "wi-1" }), filters({ blocked: "blocked" }), [], new Map(), NOW, rel)).toBe(true);
    expect(matchesFilters(item({ id: "wi-2" }), filters({ blocked: "blocked" }), [], new Map(), NOW, rel)).toBe(false);
  });

  it("filters to a milestone's work", () => {
    const rel = { milestones: new Map([["m-1", new Set(["wi-1"])]]) };
    expect(matchesFilters(item({ id: "wi-1" }), filters({ milestoneId: "m-1" }), [], new Map(), NOW, rel)).toBe(true);
    expect(matchesFilters(item({ id: "wi-2" }), filters({ milestoneId: "m-1" }), [], new Map(), NOW, rel)).toBe(false);
  });

  it("leaves BOTH inert when the caller supplies no relation data", () => {
    // Boards that do not load links or milestones pass nothing. The clause must
    // not then treat every item as unblocked-and-excluded.
    expect(matchesFilters(item(), filters())).toBe(true);
  });
});

describe("estimates", () => {
  it("filters by story points, including the unestimated band", () => {
    expect(matchesFilters(item({ storyPoints: 5 }), filters({ storyPoints: ["5"] }))).toBe(true);
    expect(matchesFilters(item({ storyPoints: 3 }), filters({ storyPoints: ["5"] }))).toBe(false);
    // The unestimated band's wire value is "NONE", not "NO_ESTIMATE" — the
    // constant's NAME is NO_ESTIMATE. Imported rather than retyped so a change
    // to the value cannot leave this test asserting a string nothing produces.
    expect(matchesFilters(item({ storyPoints: null }), filters({ storyPoints: [NO_ESTIMATE] }))).toBe(true);
    expect(matchesFilters(item({ storyPoints: 5 }), filters({ storyPoints: [NO_ESTIMATE] }))).toBe(false);
  });
});

describe("custom fields", () => {
  // Built WITHOUT a cast on purpose. The first draft said `kind: "SELECT"` and
  // cast the object; `fieldType` was then undefined, the field was treated as
  // non-filterable, and the "drops a non-matching item" test failed while
  // looking like a source bug. A cast on a fixture buys a wrong test.
  const defs: CustomField[] = [
    {
      id: "cf-1",
      orgId: "org-1",
      projectId: "proj-1",
      key: "team",
      name: "Team",
      fieldType: "SELECT",
      options: ["Platform", "Growth"],
      required: false,
      sortOrder: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ];

  it("keeps an item whose field holds the selected option", () => {
    const it1 = item({ customFields: { team: "Platform" } });
    expect(matchesFilters(it1, filters({ customFields: { team: "Platform" } }), defs)).toBe(true);
  });

  it("drops an item whose field holds something else", () => {
    const it1 = item({ customFields: { team: "Growth" } });
    expect(matchesFilters(it1, filters({ customFields: { team: "Platform" } }), defs)).toBe(false);
  });

  it("ignores an empty constraint rather than treating it as 'must be blank'", () => {
    const it1 = item({ customFields: { team: "Growth" } });
    expect(matchesFilters(it1, filters({ customFields: { team: "" } }), defs)).toBe(true);
  });
});

describe("clauses combine as AND", () => {
  it("requires every active filter to hold", () => {
    const target = item({ priority: "HIGH", columnKey: "done", assigneeId: "u-1" });
    const f = filters({ priorities: ["HIGH"], columnKeys: ["done"], assigneeId: "u-1" });

    expect(matchesFilters(target, f)).toBe(true);
    // Break exactly one clause at a time — each must be sufficient to exclude.
    expect(matchesFilters(item({ ...target, priority: "LOW" }), f)).toBe(false);
    expect(matchesFilters(item({ ...target, columnKey: "todo" }), f)).toBe(false);
    expect(matchesFilters(item({ ...target, assigneeId: "u-9" }), f)).toBe(false);
  });
});
