import { describe, it, expect } from "vitest";
import { defaultCarryForwardTarget } from "./carry-forward-target";

/**
 * Completing a sprint asks where unfinished work goes. The dialog defaulted to
 * "Backlog (no interval)", so unless someone noticed the dropdown, finishing a
 * sprint quietly emptied its remaining work out of every sprint — the opposite
 * of what Jira does, and the opposite of what a team running two-week sprints
 * expects.
 *
 * The default is now the next PLANNED sprint when there is one.
 */

const iv = (
  id: string,
  number: number,
  status: "PLANNED" | "ACTIVE" | "COMPLETED",
  kind = "SPRINT"
) => ({ id, number, status, intervalKind: kind });

describe("defaultCarryForwardTarget", () => {
  it("picks the next planned sprint by number", () => {
    const target = defaultCarryForwardTarget(iv("s1", 1, "ACTIVE"), [
      iv("s1", 1, "ACTIVE"),
      iv("s2", 2, "PLANNED"),
      iv("s3", 3, "PLANNED"),
    ]);
    expect(target).toBe("s2");
  });

  it("falls back to the backlog when nothing is planned", () => {
    // null means backlog. A team that has not created the next sprint yet must
    // not have its work pushed into a completed one.
    expect(
      defaultCarryForwardTarget(iv("s1", 1, "ACTIVE"), [
        iv("s1", 1, "ACTIVE"),
        iv("s0", 0, "COMPLETED"),
      ])
    ).toBeNull();
  });

  it("never targets a sprint that already finished", () => {
    expect(
      defaultCarryForwardTarget(iv("s2", 2, "ACTIVE"), [
        iv("s1", 1, "COMPLETED"),
        iv("s2", 2, "ACTIVE"),
      ])
    ).toBeNull();
  });

  it("never targets the sprint being completed", () => {
    expect(
      defaultCarryForwardTarget(iv("s1", 1, "ACTIVE"), [iv("s1", 1, "ACTIVE")])
    ).toBeNull();
  });

  it("ignores an EARLIER planned sprint", () => {
    // A sprint numbered below the one closing is not "next" — pushing work
    // backwards would hide it behind a sprint the team has moved past.
    expect(
      defaultCarryForwardTarget(iv("s5", 5, "ACTIVE"), [
        iv("s3", 3, "PLANNED"),
        iv("s5", 5, "ACTIVE"),
      ])
    ).toBeNull();
  });

  it("ignores Program Increments, which are containers not destinations", () => {
    expect(
      defaultCarryForwardTarget(iv("s1", 1, "ACTIVE"), [
        iv("s1", 1, "ACTIVE"),
        iv("pi", 2, "PLANNED", "PROGRAM_INCREMENT"),
      ])
    ).toBeNull();
  });
});
