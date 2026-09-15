// @vitest-environment jsdom
//
// Sprint board tags, phase 4: clearing the filter restores the full, unfiltered
// board view.
//
// "Unfiltered" is relative to the board. A Sprint board opens scoped to its
// active sprint, so "Clear" resetting to the globally empty filter did not
// restore that board — it widened to every item in the project, backlog
// included, and dropped the sprint header. Clearing a tag has to give the user
// back the board they were on.
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilterBar, emptyFilters, type BoardFilters } from "./filter-bar";
import { matchesFilters } from "@/lib/work-items/board-filters";
import { presentLabels } from "@/lib/work-items/label-filter";
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
const SPRINT = "i1";
const INTERVALS = [{ id: SPRINT, name: "Sprint 1" }] as never[];

/** A Sprint board's unfiltered state — scoped to the sprint it opened on. */
const sprintBaseline: BoardFilters = { ...emptyFilters, intervalId: SPRINT };

function renderBar(filters: BoardFilters, baseFilters?: BoardFilters) {
  const onFilterChange = vi.fn();
  render(
    <FilterBar
      filters={filters}
      onFilterChange={onFilterChange}
      members={[]}
      intervals={INTERVALS}
      orgId={ORG}
      presentLabelNames={["api", "ux"]}
      baseFilters={baseFilters}
      showSwimlane
    />,
  );
  return { onFilterChange };
}

const clearButton = () => screen.queryByRole("button", { name: /^clear$/i });

afterEach(cleanup);

describe("Clear on a sprint-scoped board", () => {
  it("is not offered when nothing has been filtered", () => {
    // The sprint scope is the board, not something the user applied — there is
    // nothing to clear, and offering to would be an invitation to widen the
    // board by accident.
    renderBar(sprintBaseline, sprintBaseline);
    expect(clearButton()).toBeNull();
  });

  it("appears once a tag is picked", () => {
    renderBar({ ...sprintBaseline, labels: ["api"] }, sprintBaseline);
    expect(clearButton()).not.toBeNull();
  });

  it("restores the sprint's full board — the tag goes, the sprint stays", () => {
    const { onFilterChange } = renderBar(
      { ...sprintBaseline, labels: ["api"] },
      sprintBaseline,
    );
    fireEvent.click(clearButton()!);
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    const next = onFilterChange.mock.calls[0][0] as BoardFilters;
    expect(next.labels).toEqual([]);
    expect(next.intervalId).toBe(SPRINT);
  });

  it("leaves the grouping the user chose in place", () => {
    const { onFilterChange } = renderBar(
      { ...sprintBaseline, labels: ["api"], swimlaneBy: "assignee" },
      sprintBaseline,
    );
    fireEvent.click(clearButton()!);
    const next = onFilterChange.mock.calls[0][0] as BoardFilters;
    expect(next.swimlaneBy).toBe("assignee");
  });

  it("does not force the long tail open for the board's own sprint scope", () => {
    // Interval lives behind "More filters". Counting the baseline sprint as
    // active pinned that row open on every Sprint board, permanently.
    renderBar(sprintBaseline, sprintBaseline);
    expect(screen.queryByLabelText(/filter by interval/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /more filters/i }).textContent,
    ).not.toMatch(/\d/);
  });

  it("still forces it open when the user moves OFF the baseline sprint", () => {
    renderBar({ ...sprintBaseline, intervalId: "i2" }, sprintBaseline);
    expect(screen.getByLabelText(/filter by interval/i)).toBeTruthy();
  });
});

describe("Clear on a board with no baseline scope", () => {
  it("empties everything, as before", () => {
    const { onFilterChange } = renderBar({
      ...emptyFilters,
      labels: ["api"],
      intervalId: SPRINT,
      search: "payload",
    });
    fireEvent.click(clearButton()!);
    const next = onFilterChange.mock.calls[0][0] as BoardFilters;
    expect(next.labels).toEqual([]);
    expect(next.intervalId).toBeNull();
    expect(next.search).toBe("");
  });
});

// --- the board in miniature -------------------------------------------------
//
// The filter bar over a list of card titles, wired the way kanban-board.tsx
// wires it: the bar's state drives `matchesFilters`, and the board declares its
// baseline. Asserting the payload of onFilterChange proves the message; this
// proves the board the user is left looking at.

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
  } as WorkItem;
}

// A Kanban board loads the project's WHOLE item list and narrows it in the
// client, so the card outside the sprint is present but must never be on screen.
const CARDS: WorkItem[] = [
  card({ id: "a", title: "Rate limiter", intervalId: SPRINT, tags: ["api"] }),
  card({ id: "b", title: "Empty states", intervalId: SPRINT, tags: ["ui"] }),
  card({ id: "c", title: "Audit trail", intervalId: SPRINT, tags: ["api", "ui"] }),
  card({ id: "d", title: "Old migration", intervalId: "i9", tags: ["api"] }),
];

function Board() {
  const [filters, setFilters] = useState<BoardFilters>(sprintBaseline);
  const visible = CARDS.filter((c) => matchesFilters(c, filters));
  return (
    <>
      <FilterBar
        filters={filters}
        onFilterChange={setFilters}
        members={[]}
        intervals={INTERVALS}
        orgId={ORG}
        presentLabelNames={presentLabels(CARDS)}
        baseFilters={sprintBaseline}
        showSwimlane
      />
      <ul>
        {visible.map((c) => (
          <li key={c.id}>{c.title}</li>
        ))}
      </ul>
    </>
  );
}

/** Tick a tag in the Label menu (the menu stays open across toggles). */
async function pickTag(name: string) {
  const trigger = screen.getByRole("button", { name: /^label/i });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
}

const titles = () => screen.getAllByRole("listitem").map((li) => li.textContent);

describe("clearing a tag filter restores the sprint's board", () => {
  it("puts back every card the sprint was showing, and nothing else", async () => {
    render(<Board />);
    const before = titles();
    expect(before).toEqual(["Rate limiter", "Empty states", "Audit trail"]);

    await pickTag("api");
    expect(titles()).toEqual(["Rate limiter", "Audit trail"]);

    fireEvent.click(clearButton()!);
    // The regression this guards: clearing to the empty filter drops the sprint
    // scope, so "Old migration" — a card from another sprint that was never on
    // this board — appears.
    expect(titles()).toEqual(before);
  });

  it("lands on the same board as unticking the last tag", async () => {
    render(<Board />);
    await pickTag("api");
    await pickTag("api");
    const byUnticking = titles();
    cleanup();

    render(<Board />);
    await pickTag("api");
    fireEvent.click(clearButton()!);
    expect(titles()).toEqual(byUnticking);
  });
});
