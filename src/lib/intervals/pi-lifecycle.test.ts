import { describe, it, expect } from "vitest";
import {
  activationBlocker,
  programIncrementBlockers,
  userMaySetStatus,
} from "./pi-lifecycle";

/**
 * A Program Increment is a CONTAINER, not a competitor.
 *
 * The one-active-interval rule asked "is any other interval in this project
 * ACTIVE?" and a PI is an Interval row, so an active PI blocked every sprint
 * inside it — the sprint could not start until its own parent finished, which
 * can never happen, because the parent finishes when its sprints do.
 */

const sprint = (id: string, status: "PLANNED" | "ACTIVE" | "COMPLETED") => ({
  id,
  name: `Sprint ${id}`,
  intervalKind: "SPRINT" as const,
  status,
});
const pi = (id: string, status: "PLANNED" | "ACTIVE" | "COMPLETED") => ({
  id,
  name: `PI ${id}`,
  intervalKind: "PROGRAM_INCREMENT" as const,
  status,
});

describe("activationBlocker", () => {
  it("does NOT let an active PI block a sprint inside it", () => {
    // The bug: a sprint could never start while its own PI was running.
    expect(activationBlocker({ id: "s1" }, [pi("pi1", "ACTIVE")])).toBeNull();
  });

  it("still blocks a second concurrent sprint", () => {
    const blocker = activationBlocker({ id: "s2" }, [sprint("s1", "ACTIVE")]);
    expect(blocker?.id).toBe("s1");
  });

  it("ignores the interval being started", () => {
    // Re-activating an already-ACTIVE interval must not block on itself.
    expect(activationBlocker({ id: "s1" }, [sprint("s1", "ACTIVE")])).toBeNull();
  });

  it("ignores intervals that are not running", () => {
    expect(
      activationBlocker({ id: "s2" }, [
        sprint("s1", "COMPLETED"),
        sprint("s3", "PLANNED"),
      ])
    ).toBeNull();
  });

  it("blocks on a running sprint even when a PI is also running", () => {
    // The PI is filtered out; the real conflict still has to surface.
    const blocker = activationBlocker({ id: "s2" }, [
      pi("pi1", "ACTIVE"),
      sprint("s1", "ACTIVE"),
    ]);
    expect(blocker?.id).toBe("s1");
  });
});

describe("programIncrementBlockers", () => {
  it("names the sprints still open, so the refusal can say which", () => {
    const open = programIncrementBlockers([
      sprint("s1", "COMPLETED"),
      sprint("s2", "ACTIVE"),
      sprint("s3", "PLANNED"),
    ]);
    expect(open.map((i) => i.id)).toEqual(["s2", "s3"]);
  });

  it("allows completion once every sprint is done", () => {
    expect(
      programIncrementBlockers([sprint("s1", "COMPLETED"), sprint("s2", "COMPLETED")])
    ).toEqual([]);
  });

  it("allows completing a PI that never had sprints", () => {
    // Nothing outstanding is nothing outstanding.
    expect(programIncrementBlockers([])).toEqual([]);
  });
});

describe("userMaySetStatus", () => {
  it("refuses to let a user start a PI", () => {
    // A PI starts when its first sprint does. Offering the control invites a PI
    // that is 'running' with nothing inside it.
    expect(userMaySetStatus("PROGRAM_INCREMENT", "ACTIVE")).toBe(false);
  });

  it("lets a user complete a PI", () => {
    // Gated on its sprints — but the decision that a PI is done stays human.
    expect(userMaySetStatus("PROGRAM_INCREMENT", "COMPLETED")).toBe(true);
  });

  it("leaves ordinary intervals fully under user control", () => {
    expect(userMaySetStatus("SPRINT", "ACTIVE")).toBe(true);
    expect(userMaySetStatus("PHASE", "ACTIVE")).toBe(true);
  });
});
