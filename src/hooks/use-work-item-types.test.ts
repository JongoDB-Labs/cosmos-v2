import { describe, it, expect } from "vitest";
import { SHADOW_TYPE_KEYS, selectableTypes } from "./use-work-item-types";

// Six entities exist twice: Goal, KeyResult, Kpi, Milestone, Objective and Risk
// each have a dedicated Prisma model AND a cross-cutting work-item type. A
// "Milestone" created from a New issue dialog is therefore a WorkItem, and never
// appears on the Milestones board — the reported symptom.
//
// They are hidden from creation, NOT deleted: existing items keep their type and
// stay editable.
const TYPES = [
  { id: "t1", key: "software.task", name: "Task" },
  { id: "t2", key: "software.bug", name: "Bug" },
  { id: "m1", key: "cross.milestone", name: "Milestone" },
  { id: "g1", key: "cross.goal", name: "Goal" },
  { id: "r1", key: "cross.risk", name: "Risk" },
];

describe("selectableTypes", () => {
  it("hides every type that shadows a real table when creating", () => {
    expect(selectableTypes(TYPES).map((t) => t.key)).toEqual([
      "software.task",
      "software.bug",
    ]);
  });

  it("keeps the item's OWN type when editing, even if it is a shadow type", () => {
    // Without this an item already filed as "Milestone" renders a blank Select
    // and cannot be retyped to anything valid — hiding the type would strand it.
    const opts = selectableTypes(TYPES, "m1");
    expect(opts.map((t) => t.key)).toContain("cross.milestone");
    // ...but the OTHER shadows stay hidden, so it can only move toward a real type.
    expect(opts.map((t) => t.key)).not.toContain("cross.goal");
  });

  // Six shadowed ENTITIES, seven keys: Milestone is seeded twice, once
  // cross-cutting and once by the consulting sector. Both create a WorkItem
  // that never reaches the Milestones board, so both have to be hidden.
  // shadowed-types.test.ts derives this from the seeds rather than listing it.
  it("covers every key that shadows a real table", () => {
    expect([...SHADOW_TYPE_KEYS].sort()).toEqual([
      "consulting.milestone_item",
      "cross.goal",
      "cross.key_result",
      "cross.kpi",
      "cross.milestone",
      "cross.objective",
      "cross.risk",
    ]);
  });

  it("leaves ordinary types alone", () => {
    const ordinary = [{ id: "t1", key: "software.epic", name: "Epic" }];
    expect(selectableTypes(ordinary)).toEqual(ordinary);
  });
});
