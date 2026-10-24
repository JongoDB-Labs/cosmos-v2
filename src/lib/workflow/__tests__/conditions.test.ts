import { describe, it, expect } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import { evaluateCondition, restrictionAllows, restrictionMayAllow, type ConditionContext } from "../conditions";
import type { ConditionNode } from "../definition";

const ALICE = "alice";

function ctx(over: Partial<ConditionContext> = {}): ConditionContext {
  return {
    actor: { userId: ALICE, orgRole: "MEMBER", permissions: Permission.ITEM_UPDATE, projectRole: "CONTRIBUTOR", teamIds: ["blue"] },
    item: {
      createdById: "bob",
      assigneeIds: [ALICE],
      teamId: "blue",
      fields: { priority: "HIGH", storyPoints: 5, dueDate: null },
      customFields: { root_cause: "", severity: "3" },
    },
    history: { previousStatus: "review", lastTransitionActor: { approve: "bob" } },
    ...over,
  };
}

const ev = (n: ConditionNode, c = ctx()) => evaluateCondition(n, c);

describe("evaluateCondition", () => {
  it("evaluates actor predicates", () => {
    expect(ev({ kind: "actorIsAssignee" })).toBe("true");
    expect(ev({ kind: "actorIsCreator" })).toBe("false");
    expect(ev({ kind: "actorHasPermission", permission: "ITEM_UPDATE" })).toBe("true");
    expect(ev({ kind: "actorHasPermission", permission: "ITEM_DELETE" })).toBe("false");
    expect(ev({ kind: "actorOrgRole", in: ["ADMIN", "OWNER"] })).toBe("false");
    expect(ev({ kind: "actorProjectRole", in: ["CONTRIBUTOR"] })).toBe("true");
    expect(ev({ kind: "actorInTeam", teamId: "item" })).toBe("true");
    expect(ev({ kind: "actorInTeam", teamId: "red" })).toBe("false");
  });

  it("separation of duties: the approver may not also run the transition", () => {
    const n: ConditionNode = { kind: "actorIsNot", ref: "lastTransitionActor", transitionId: "approve" };
    expect(ev(n)).toBe("true");
    expect(ev(n, ctx({ actor: { ...ctx().actor, userId: "bob" } }))).toBe("false");
    // Nobody approved yet: nobody to separate from.
    expect(ev({ ...n, transitionId: "never-run" })).toBe("true");
  });

  it("compares fields with the ABAC operators, coercing numeric strings", () => {
    expect(ev({ kind: "field", field: { system: "priority" }, op: "in", value: ["HIGH", "CRITICAL"] })).toBe("true");
    expect(ev({ kind: "field", field: { custom: "severity" }, op: "gte", value: 3 })).toBe("true");
    expect(ev({ kind: "field", field: { system: "dueDate" }, op: "isEmpty" })).toBe("true");
    expect(ev({ kind: "field", field: { custom: "root_cause" }, op: "isNotEmpty" })).toBe("false");
  });

  it("combines with all / any / not", () => {
    const yes: ConditionNode = { kind: "actorIsAssignee" };
    const no: ConditionNode = { kind: "actorIsCreator" };
    expect(ev({ all: [yes, no] })).toBe("false");
    expect(ev({ any: [yes, no] })).toBe("true");
    expect(ev({ not: no })).toBe("true");
  });

  // --- fail-closed (the ABAC engine's risk list) ------------------------------

  it("an unknown node kind is unresolvable, so the restriction hides the transition", () => {
    const unknown = { kind: "runScript" } as unknown as ConditionNode;
    expect(ev(unknown)).toBe("unresolvable");
    expect(restrictionAllows(unknown, ctx())).toBe(false);
    // NOT of unknown must not flip into an allow.
    expect(restrictionAllows({ not: unknown }, ctx())).toBe(false);
  });

  it("a missing field is unresolvable, not a silent false-then-true via NOT", () => {
    const n: ConditionNode = { kind: "field", field: { custom: "absent" }, op: "eq", value: "x" };
    expect(ev(n)).toBe("unresolvable");
    expect(restrictionAllows({ not: n }, ctx())).toBe(false);
  });

  it("refuses prototype paths", () => {
    expect(ev({ kind: "field", field: { custom: "__proto__" }, op: "ne", value: "x" })).toBe("unresolvable");
    expect(ev({ kind: "field", field: { custom: "constructor" }, op: "ne", value: "x" })).toBe("unresolvable");
  });

  it("an actor fact the caller did not load is unresolvable, never assumed", () => {
    const bare = ctx({ actor: { userId: ALICE, orgRole: "MEMBER", permissions: 0n } });
    expect(ev({ kind: "actorInTeam", teamId: "blue" }, bare)).toBe("unresolvable");
    expect(ev({ kind: "actorProjectRole", in: ["CONTRIBUTOR"] }, bare)).toBe("unresolvable");
    expect(ev({ kind: "previousStatus", in: ["review"] }, ctx({ history: {} }))).toBe("unresolvable");
  });

  it("a definite false decides an AND even beside an unresolvable", () => {
    const unknown = { kind: "nope" } as unknown as ConditionNode;
    expect(ev({ all: [unknown, { kind: "actorIsCreator" }] })).toBe("false");
    expect(ev({ any: [unknown, { kind: "actorIsAssignee" }] })).toBe("true");
  });

  it("no restriction allows; an empty-handed actor is not elevated by one", () => {
    expect(restrictionAllows(undefined, ctx())).toBe(true);
    expect(restrictionAllows({ kind: "actorHasPermission", permission: "PROJECT_MANAGE" }, ctx())).toBe(false);
  });
});

describe("restrictionMayAllow (no item)", () => {
  const actor = ctx().actor;
  it("is false only when the actor can never take it", () => {
    expect(restrictionMayAllow(undefined, actor)).toBe(true);
    expect(restrictionMayAllow({ kind: "actorOrgRole", in: ["OWNER"] }, actor)).toBe(false);
    expect(restrictionMayAllow({ kind: "actorHasPermission", permission: "ITEM_DELETE" }, actor)).toBe(false);
  });

  it("counts what depends on the item as possible, negated or not", () => {
    for (const n of [
      { kind: "actorIsAssignee" },
      { not: { kind: "actorIsCreator" } },
      { kind: "field", field: { system: "priority" }, op: "eq", value: "HIGH" },
      { kind: "actorInTeam", teamId: "item" },
    ] as ConditionNode[]) {
      expect(restrictionMayAllow(n, actor)).toBe(true);
    }
    // ...but an AND with a definite no is still no.
    expect(restrictionMayAllow({ all: [{ kind: "actorIsAssignee" }, { kind: "actorOrgRole", in: ["OWNER"] }] }, actor)).toBe(false);
  });

  it("never lets an item-free answer decide a real move", () => {
    expect(restrictionAllows({ kind: "actorIsAssignee" }, { actor })).toBe(false);
  });
});
