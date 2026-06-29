import { describe, it, expect } from "vitest";
import { deriveMilestone, type MilestoneWithLinks } from "./schedule";

const NOW = new Date("2026-06-15T00:00:00Z");
const FUTURE = new Date("2026-07-01T00:00:00Z");
const PAST = new Date("2026-06-01T00:00:00Z");

function ms(
  o: Partial<MilestoneWithLinks> & { itemIds: string[] },
): MilestoneWithLinks {
  return {
    id: "m1",
    orgId: "o",
    projectId: "p",
    title: "M",
    description: null,
    dueDate: FUTURE,
    status: "UPCOMING",
    autoStatus: true,
    completedAt: null,
    ownerId: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    branchId: null,
    baselineDate: null,
    projectedDate: null,
    actualDate: null,
    rootCause: null,
    recoveryPlan: null,
    recoveryTarget: null,
    phase: null,
    scheduleEscalate: false,
    ...o,
    links: o.itemIds.map((workItemId, i) => ({
      id: `l${i}`,
      milestoneId: "m1",
      workItemId,
      createdAt: NOW,
    })),
  } as MilestoneWithLinks;
}

const cols = (m: Record<string, string>) => new Map(Object.entries(m));

describe("deriveMilestone", () => {
  it("keeps stored status + null completion when there are no links", () => {
    const r = deriveMilestone(ms({ itemIds: [], status: "UPCOMING" }), cols({}), NOW);
    expect(r.status).toBe("UPCOMING");
    expect(r.completionPercent).toBeNull();
    expect(r.linkedTotal).toBe(0);
  });

  it("all linked items done → COMPLETED at 100%", () => {
    const r = deriveMilestone(
      ms({ itemIds: ["a", "b"], dueDate: FUTURE }),
      cols({ a: "done", b: "done" }),
      NOW,
    );
    expect(r.status).toBe("COMPLETED");
    expect(r.completionPercent).toBe(100);
    expect(r.linkedDone).toBe(2);
  });

  it("past due and not all done → MISSED", () => {
    const r = deriveMilestone(
      ms({ itemIds: ["a", "b"], dueDate: PAST }),
      cols({ a: "done", b: "todo" }),
      NOW,
    );
    expect(r.status).toBe("MISSED");
    expect(r.completionPercent).toBe(50);
  });

  it("any item in progress (not done, not backlog/todo) → IN_PROGRESS", () => {
    const r = deriveMilestone(
      ms({ itemIds: ["a", "b"], dueDate: FUTURE }),
      cols({ a: "in-progress", b: "todo" }),
      NOW,
    );
    expect(r.status).toBe("IN_PROGRESS");
    expect(r.completionPercent).toBe(0);
  });

  it("only backlog/todo items → UPCOMING", () => {
    const r = deriveMilestone(
      ms({ itemIds: ["a", "b"], dueDate: FUTURE }),
      cols({ a: "todo", b: "backlog" }),
      NOW,
    );
    expect(r.status).toBe("UPCOMING");
  });

  it("autoStatus off → keeps stored status but still reports completion", () => {
    const r = deriveMilestone(
      ms({ itemIds: ["a"], autoStatus: false, status: "COMPLETED" }),
      cols({ a: "todo" }),
      NOW,
    );
    expect(r.status).toBe("COMPLETED"); // stored, not derived
    expect(r.completionPercent).toBe(0); // but completion still computed
  });

  it("tolerates dangling links (deleted work items are skipped)", () => {
    const r = deriveMilestone(
      ms({ itemIds: ["a", "gone"], dueDate: FUTURE }),
      cols({ a: "done" }), // "gone" not in the map
      NOW,
    );
    expect(r.linkedTotal).toBe(1);
    expect(r.status).toBe("COMPLETED");
    expect(r.completionPercent).toBe(100);
  });
});
