// @vitest-environment jsdom
//
// The Milestone control is opt-in: it renders only when the host supplies
// options. That gate is what lets the Sprint board drop it — a milestone spans
// months and cuts across sprints, so on a board already scoped to ONE sprint it
// filters a set that is nearly always all-or-nothing.
//
// The gate was previously relied on but untested, so nothing stopped a future
// caller from passing options unconditionally and putting the control back on
// every board.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilterBar, emptyFilters } from "./filter-bar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/TEST/boards/b1",
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => ({ data: undefined, isLoading: false }) };
});

const ORG = "11111111-1111-4111-8111-111111111111";

/** The Milestone control lives behind the "More filters" disclosure, so every
 *  assertion here has to open it first — otherwise "absent" is true of every
 *  control in the overflow and proves nothing. */
function openOverflow() {
  fireEvent.click(screen.getByRole("button", { name: /more filters/i }));
}

function renderBar(milestoneOptions?: { id: string; title: string }[]) {
  render(
    <FilterBar
      filters={emptyFilters}
      onFilterChange={vi.fn()}
      members={[]}
      intervals={[] as never[]}
      teams={[]}
      orgId={ORG}
      {...(milestoneOptions ? { milestoneOptions } : {})}
    />,
  );
}

afterEach(cleanup);

describe("the Milestone filter is opt-in", () => {
  it("is absent when the board supplies no milestones", () => {
    renderBar();
    openOverflow();
    expect(screen.queryByText(/milestone:/i)).toBeNull();
  });

  it("is absent when the board supplies an EMPTY list", () => {
    // How the Sprint board opts out: it passes [] rather than omitting the prop.
    renderBar([]);
    openOverflow();
    expect(screen.queryByText(/milestone:/i)).toBeNull();
  });

  it("appears once a board supplies milestones", () => {
    // Guards the guard: if this never rendered, the two assertions above would
    // pass no matter what the component did.
    renderBar([{ id: "m1", title: "Beta launch" }]);
    openOverflow();
    expect(screen.getByText(/milestone:/i)).toBeTruthy();
  });
});
