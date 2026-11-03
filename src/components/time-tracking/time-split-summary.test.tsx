// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { TimeSplitSummary } from "./time-split-summary";

afterEach(cleanup);

describe("TimeSplitSummary", () => {
  it("reports project and internal time separately, with the internal breakdown", () => {
    render(
      <TimeSplitSummary
        categories={["Overhead", "Business development", "Professional development"]}
        entries={[
          { hours: 30, projectId: "p1" },
          { hours: 4, projectId: null, internalCategory: "Overhead" },
          { hours: 2, projectId: null, internalCategory: "Professional development" },
        ]}
      />,
    );
    expect(screen.getByTestId("split-project").textContent).toBe("30.00 h");
    expect(screen.getByTestId("split-internal").textContent).toBe("6.00 h");
    const items = within(screen.getByRole("list", { name: "Internal time by category" })).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Overhead: 4.00 h", "Professional development: 2.00 h"]);
    // No uncategorised, project-less time here, so no third figure.
    expect(screen.queryByTestId("split-unassigned")).toBeNull();
  });

  it("shows time with neither a project nor a category as its own figure", () => {
    render(
      <TimeSplitSummary
        categories={["Overhead"]}
        entries={[
          { hours: 1, projectId: null, internalCategory: "Overhead" },
          { hours: 2.5, projectId: null },
        ]}
      />,
    );
    expect(screen.getByTestId("split-unassigned").textContent).toBe("2.50 h");
  });

  it("renders nothing when there is no internal time — the page is unchanged for orgs that don't use it", () => {
    const { container } = render(
      <TimeSplitSummary categories={["Overhead"]} entries={[{ hours: 8, projectId: "p1" }, { hours: 1, projectId: null }]} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
