// @vitest-environment jsdom
//
// The Interval control is fed the project's WHOLE interval list — the API
// applies no `intervalKind` filter — so Program Increments sit in this dropdown
// beside the sprints. Two problems followed from that, and this file covers the
// second (the first, a PI selection matching no work and blanking the board,
// is lib/work-items/board-filters):
//
// A PI and a sprint were rendered identically. "PI 3" and "Sprint 3" are the
// same shape of string, so the one control that scopes a board to a quarter
// looked exactly like the one that scopes it to two weeks, and the trigger gave
// no clue which you had picked. Filtering on a PI is a deliberate, much wider
// act than filtering on a sprint; the label has to say so.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilterBar, emptyFilters, intervalOptionLabel } from "./filter-bar";
import type { BoardFilters } from "./filter-bar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/TEST/boards/b1",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => ({ data: undefined, isLoading: false }) };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const PI_KIND = "PROGRAM_INCREMENT";

const INTERVALS = [
  { id: "pi-1", name: "PI 1", intervalKind: PI_KIND, number: 1, parentId: null },
  { id: "s-1", name: "Sprint 1", intervalKind: "SPRINT", number: 1, parentId: "pi-1" },
] as never[];

/** The Interval control is in OVERFLOW_KEYS, so it lives behind the disclosure.
 *  An active intervalId forces that row open on its own, but open it anyway so
 *  the unset cases are asserting against a control that is actually present. */
function renderBar(over: Partial<BoardFilters> = {}) {
  render(
    <FilterBar
      filters={{ ...emptyFilters, ...over }}
      onFilterChange={vi.fn()}
      members={[]}
      intervals={INTERVALS}
      teams={[]}
      orgId={ORG}
    />,
  );
  const more = screen.queryByRole("button", { name: /more filters/i });
  if (more) fireEvent.click(more);
}

afterEach(cleanup);

describe("intervalOptionLabel", () => {
  it("marks a Program Increment as the whole PI", () => {
    expect(intervalOptionLabel(INTERVALS[0])).toBe("PI 1 (whole PI)");
  });

  it("leaves a sprint's name alone", () => {
    expect(intervalOptionLabel(INTERVALS[1])).toBe("Sprint 1");
  });

  it("does not mark an interval of unknown kind", () => {
    // The list carries whatever the API returns; an unrecognised kind must read
    // as its plain name rather than claim to be a PI.
    expect(intervalOptionLabel({ id: "x", name: "Release 4" } as never)).toBe("Release 4");
  });
});

describe("the Interval trigger says WHICH kind is scoping the board", () => {
  it("reads as the whole PI when a PI is selected", () => {
    renderBar({ intervalId: "pi-1" });
    expect(screen.getByLabelText(/filter by interval/i).textContent).toMatch(/whole PI/i);
  });

  it("reads as just the sprint name when a sprint is selected", () => {
    renderBar({ intervalId: "s-1" });
    const trigger = screen.getByLabelText(/filter by interval/i);
    expect(trigger.textContent).toMatch(/Sprint 1/);
    expect(trigger.textContent).not.toMatch(/whole PI/i);
  });
});
