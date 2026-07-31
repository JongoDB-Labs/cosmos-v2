// @vitest-environment jsdom
//
// The filter bar had grown past what one row can carry — search, assignee,
// type, priority, label, team, interval, custom fields — with more metadata
// still to come. So the long tail moved behind a "More filters" disclosure,
// leaving inline only what a board is actually sliced by minute to minute.
//
// Progressive disclosure has one failure mode, and it is the whole reason these
// tests exist: a filter that is ACTIVE but HIDDEN. The board comes up narrowed,
// the control that narrowed it is collapsed out of sight, and the reader
// concludes something is broken. So the overflow row forces itself open
// whenever anything inside it is set, and the toggle carries a count.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilterBar, emptyFilters, type BoardFilters } from "./filter-bar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/TEST/boards/b1",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => ({ data: undefined, isLoading: false }) };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const TEAMS = [{ id: "t1", name: "Alpha" }];
const INTERVALS = [{ id: "i1", name: "Sprint 1" }] as never[];

function renderBar(over: Partial<BoardFilters> = {}) {
  const onFilterChange = vi.fn();
  render(
    <FilterBar
      filters={{ ...emptyFilters, ...over }}
      onFilterChange={onFilterChange}
      members={[]}
      intervals={INTERVALS}
      teams={TEAMS}
      orgId={ORG}
      showSwimlane
    />,
  );
  return { onFilterChange };
}

afterEach(cleanup);

describe("filter bar — what stays inline", () => {
  it("keeps the high-frequency filters on the primary row", () => {
    renderBar();
    // Ordered by how often a board is sliced that way: who it's on, what it is,
    // how urgent, then labels. Assignee is a labelled control; Type and
    // Priority are menu buttons.
    expect(screen.getByLabelText(/filter by assignee/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^type/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^priority/i })).toBeTruthy();
  });

  it("puts Assignee before Type and Priority — most-used first", () => {
    renderBar();
    const bar = screen.getByLabelText(/filter by assignee/i).closest("div")!.parentElement!;
    const text = bar.parentElement!.textContent ?? "";
    expect(text.indexOf("Assignee")).toBeLessThan(text.indexOf("Priority"));
  });

  it("collapses the long tail behind a disclosure by default", () => {
    renderBar();
    expect(screen.getByRole("button", { name: /more filters/i })).toBeTruthy();
    expect(screen.queryByLabelText(/filter by team/i)).toBeNull();
    expect(screen.queryByLabelText(/filter by interval/i)).toBeNull();
  });

  it("opens the long tail on request", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));
    expect(screen.getByLabelText(/filter by team/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /fewer filters/i })).toBeTruthy();
  });
});

describe("filter bar — an ACTIVE filter is never hidden", () => {
  it("forces the row open when a collapsed filter is already set", () => {
    // The failure this design exists to prevent: a narrowed board whose reason
    // is out of sight.
    renderBar({ teamId: "t1" });
    expect(screen.getByLabelText(/filter by team/i)).toBeTruthy();
  });

  it("says HOW MANY are set, so the count is visible before opening", () => {
    renderBar({ teamId: "t1", intervalId: "i1" });
    const toggle = screen.getByRole("button", { name: /filters/i });
    expect(toggle.textContent).toMatch(/2/);
  });

  it("cannot be collapsed back into hiding an active filter", () => {
    // Clicking the toggle while something is set must not conceal it.
    renderBar({ teamId: "t1" });
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    expect(screen.getByLabelText(/filter by team/i)).toBeTruthy();
  });

  it("reports itself as expanded to assistive tech when forced open", () => {
    renderBar({ teamId: "t1" });
    expect(
      screen.getByRole("button", { name: /filters/i }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
