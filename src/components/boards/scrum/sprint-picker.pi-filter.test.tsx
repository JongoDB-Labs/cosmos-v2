// @vitest-environment jsdom
//
// 3d90c48e asked for two things on the sprint row: expand/collapse a PI to pick
// a sprint (COSMOS-203, already shipped), "or filter on the PI itself".
//
// The second half had no control at all. The PI's label was a pure
// expand/collapse toggle, so the only way to scope a board to a whole Program
// Increment was the Interval dropdown behind "More filters" — and that was
// broken too: a PI id was compared exactly against each item's sprint id, so it
// matched nothing and blanked the board (see lib/work-items/board-filters).
//
// So the PI label now scopes the board, and the chevron beside it owns
// expand/collapse. Splitting them rather than adding a third control matters:
// ffe324aa is a complaint that this very row is too cluttered, so the fix had
// to spend no new horizontal space.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SprintPicker } from "./sprint-board";
import type { Interval } from "@/types/models";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/projects/ALPHA/boards/b1" }));
vi.mock("@/components/boards/kanban/kanban-board", () => ({ KanbanBoard: () => null }));
vi.mock("@/components/intervals/intervals-workspace", () => ({ IntervalsWorkspace: () => null }));

const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function iv(p: Partial<Interval> & Pick<Interval, "id" | "name" | "number">): Interval {
  return {
    orgId: "o1",
    projectId: "p1",
    intervalKind: "SPRINT",
    goal: "",
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: "2026-01-14T00:00:00.000Z",
    status: "PLANNED",
    parentId: null,
    report: null,
    ...p,
  };
}

const PI2 = iv({ id: "pi2", name: "PI 2", number: 2, intervalKind: "PROGRAM_INCREMENT", status: "ACTIVE", endDate: "2026-12-31T00:00:00.000Z" });
const S3 = iv({ id: "s3", name: "Sprint 3", number: 5, parentId: "pi2", status: "ACTIVE" });
const S4 = iv({ id: "s4", name: "Sprint 4", number: 6, parentId: "pi2" });
const ALL = [PI2, S3, S4];

afterEach(cleanup);

function renderPicker(shownId: string | null, intervals = ALL) {
  const onSelect = vi.fn();
  render(<SprintPicker intervals={intervals} shownId={shownId} onSelect={onSelect} onManage={() => {}} now={NOW} />);
  return onSelect;
}

/** The PI's scope control, as distinct from the chevron that expands it. */
const piScope = (name: string) => screen.getByRole("button", { name: `Show all work in ${name}` });
const piChevron = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`(Collapse|Expand) ${name}`) });

describe("filtering on the PI itself", () => {
  it("scopes the board to the whole PI when its name is clicked", () => {
    const onSelect = renderPicker("s3");
    fireEvent.click(piScope("PI 2"));
    expect(onSelect).toHaveBeenCalledWith("pi2");
  });

  it("marks the PI as the current scope, and no sprint as pressed", () => {
    renderPicker("pi2");
    expect(piScope("PI 2")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Sprint 3" })).toHaveAttribute("aria-pressed", "false");
  });

  it("does not mark the PI as the scope when a sprint under it is shown", () => {
    // The PI holding the shown sprint still EXPANDS, but it is not the scope —
    // conflating the two would make "this PI" and "a sprint in it" look alike.
    renderPicker("s3");
    expect(piScope("PI 2")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Sprint 3" })).toHaveAttribute("aria-pressed", "true");
  });

  it("expands and collapses from the chevron WITHOUT changing the scope", () => {
    const onSelect = renderPicker("s3");
    const group = screen.getByRole("group", { name: "PI 2" });

    // Open by default (current PI). Collapsing must hide its sprints and must
    // not re-scope the board — the old single button could only ever do one of
    // the two, and this is the regression that would reappear if they re-merged.
    fireEvent.click(piChevron("PI 2"));
    expect(within(group).queryByRole("button", { name: "Sprint 3" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(piChevron("PI 2"));
    expect(within(group).getByRole("button", { name: "Sprint 3" })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a PI reachable as a scope even while collapsed", () => {
    // Collapsing hides the sprints, never the PI's own scope control — a
    // collapsed PI you cannot filter on is the feature missing again.
    const onSelect = renderPicker("s3");
    fireEvent.click(piChevron("PI 2"));
    fireEvent.click(piScope("PI 2"));
    expect(onSelect).toHaveBeenCalledWith("pi2");
  });

  it("offers no PI scope control for a project without PIs", () => {
    renderPicker("a", [iv({ id: "a", name: "Sprint A", number: 1 })]);
    expect(screen.queryByRole("button", { name: /Show all work in/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Sprint A" })).toBeTruthy();
  });
});
