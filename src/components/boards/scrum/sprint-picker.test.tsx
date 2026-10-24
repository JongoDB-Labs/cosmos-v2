// @vitest-environment jsdom
//
// COSMOS-203, from a release train engineer: on the sprint board, past
// Program Increments start collapsed, stay one click from expanding, and a
// sprint picked from one says it's past work so nobody edits it by accident.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SprintPicker } from "./sprint-board";
import { isPastProgramIncrement } from "@/lib/intervals/interval-tree";
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

const PI1 = iv({ id: "pi1", name: "PI 1", number: 1, intervalKind: "PROGRAM_INCREMENT", status: "COMPLETED", endDate: "2026-06-30T00:00:00.000Z" });
const PI2 = iv({ id: "pi2", name: "PI 2", number: 2, intervalKind: "PROGRAM_INCREMENT", status: "ACTIVE", endDate: "2026-12-31T00:00:00.000Z" });
const OLD = iv({ id: "s1", name: "Sprint 1", number: 3, parentId: "pi1", status: "COMPLETED" });
const OLD2 = iv({ id: "s2", name: "Sprint 2", number: 4, parentId: "pi1", status: "COMPLETED" });
const CUR = iv({ id: "s3", name: "Sprint 3", number: 5, parentId: "pi2", status: "ACTIVE" });
const ALL = [PI1, PI2, OLD, OLD2, CUR];

afterEach(cleanup);

function renderPicker(shownId: string | null, intervals = ALL) {
  const onSelect = vi.fn();
  render(<SprintPicker intervals={intervals} shownId={shownId} onSelect={onSelect} onManage={() => {}} now={NOW} />);
  return onSelect;
}

describe("SprintPicker", () => {
  it("collapses a past PI and expands the current one by default", () => {
    renderPicker("s3");

    expect(screen.getByRole("button", { name: /PI 1/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Sprint 1" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "PI 1" })).getByText("2 sprints")).toBeTruthy();

    expect(screen.getByRole("button", { name: /PI 2/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Sprint 3" })).toBeTruthy();
  });

  it("expands a past PI on demand so its sprints can be revisited", () => {
    const onSelect = renderPicker("s3");

    fireEvent.click(screen.getByRole("button", { name: /PI 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sprint 1" }));

    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("opens the past PI holding the sprint on screen, and says it is past work", () => {
    renderPicker("s1");

    expect(screen.getByRole("button", { name: /PI 1/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status").textContent).toMatch(/viewing PI 1, a past\s+Program Increment/);
  });

  it("does not warn while viewing the current PI", () => {
    renderPicker("s3");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the plain sprint list for a project without PIs", () => {
    renderPicker("a", [iv({ id: "a", name: "Sprint A", number: 1 }), iv({ id: "b", name: "Sprint B", number: 2 })]);

    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Sprint A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sprint B" })).toBeTruthy();
  });
});

describe("isPastProgramIncrement", () => {
  it("is past once completed, or once its end date has gone by", () => {
    expect(isPastProgramIncrement({ status: "COMPLETED", endDate: "2027-01-01" }, NOW)).toBe(true);
    expect(isPastProgramIncrement({ status: "ACTIVE", endDate: "2026-10-01" }, NOW)).toBe(true);
    expect(isPastProgramIncrement({ status: "ACTIVE", endDate: "2026-12-31" }, NOW)).toBe(false);
  });
});
