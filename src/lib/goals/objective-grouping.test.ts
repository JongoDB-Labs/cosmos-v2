import { describe, it, expect } from "vitest";
import {
  groupObjectivesByInterval,
  NO_INTERVAL,
  type PanelInterval,
  type PanelObjective,
} from "./objective-grouping";

const iv = (
  id: string,
  status: PanelInterval["status"],
  startDate: string,
  goal?: string,
): PanelInterval => ({ id, name: id.toUpperCase(), status, startDate, goal });

const ob = (
  id: string,
  intervalId: string | null,
  committed = true,
): PanelObjective => ({ id, title: id, progress: 0, committed, intervalId });

describe("groupObjectivesByInterval", () => {
  it("groups objectives under the interval they're committed to", () => {
    const groups = groupObjectivesByInterval(
      [ob("a", "pi1"), ob("b", "pi1"), ob("c", "s1")],
      [iv("pi1", "ACTIVE", "2026-01-01"), iv("s1", "PLANNED", "2026-02-01")],
    );
    expect(groups.map((g) => g.key)).toEqual(["pi1", "s1"]);
    expect(groups[0].objectives.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("counts only committed objectives, not stretch ones", () => {
    // The committed count is what a PI is accountable for; folding stretch into
    // it would overstate the commitment.
    const groups = groupObjectivesByInterval(
      [ob("a", "pi1"), ob("b", "pi1", false), ob("c", "pi1", false)],
      [iv("pi1", "ACTIVE", "2026-01-01")],
    );
    expect(groups[0].committedCount).toBe(1);
    expect(groups[0].objectives).toHaveLength(3);
  });

  it("surfaces an interval's own goal even with no objectives on it", () => {
    // The sprint goal IS the thing worth showing; requiring an objective first
    // would leave it buried in interval settings, which is the original problem.
    const groups = groupObjectivesByInterval([], [iv("s1", "ACTIVE", "2026-01-01", "Ship the importer")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].intervalGoal).toBe("Ship the importer");
    expect(groups[0].objectives).toEqual([]);
  });

  it("ignores a blank interval goal", () => {
    // `Interval.goal` defaults to "" — an empty group per sprint would be noise.
    const groups = groupObjectivesByInterval([], [iv("s1", "ACTIVE", "2026-01-01", "   ")]);
    expect(groups).toEqual([]);
  });

  it("sorts ACTIVE before PLANNED before COMPLETED, then by start date", () => {
    const groups = groupObjectivesByInterval(
      [ob("a", "done"), ob("b", "later"), ob("c", "sooner"), ob("d", "live")],
      [
        iv("done", "COMPLETED", "2025-01-01"),
        iv("later", "PLANNED", "2026-05-01"),
        iv("sooner", "PLANNED", "2026-03-01"),
        iv("live", "ACTIVE", "2026-09-01"),
      ],
    );
    expect(groups.map((g) => g.key)).toEqual(["live", "sooner", "later", "done"]);
  });

  it("puts untimeboxed objectives last", () => {
    const groups = groupObjectivesByInterval(
      [ob("loose", null), ob("planned", "pi1")],
      [iv("pi1", "PLANNED", "2026-01-01")],
    );
    expect(groups.map((g) => g.key)).toEqual(["pi1", NO_INTERVAL]);
    expect(groups[1].label).toBe("Not in an interval");
  });

  it("keeps an objective whose interval can't be resolved", () => {
    // Deleted interval, or one the user lacks SPRINT_READ for — the objective
    // must still be reachable rather than silently vanishing.
    const groups = groupObjectivesByInterval([ob("orphan", "ghost")], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Unknown interval");
    expect(groups[0].objectives.map((o) => o.id)).toEqual(["orphan"]);
  });
});
