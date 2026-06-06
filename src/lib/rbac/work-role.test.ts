import { describe, it, expect } from "vitest";
import {
  workRolePolicySchema,
  workRolePoliciesSchema,
  workRoleUpdateSchema,
  workRoleCreateSchema,
} from "./work-role";

/**
 * Locks the authoring-time validation of work-role ABAC deny policies. The
 * engine (engine.ts) also re-coerces stored rules at read time, but write-time
 * rejection of malformed/inert/unbacked rules is the first line of defense.
 */
describe("workRolePolicySchema", () => {
  it("accepts a deny rule with a backed relationship", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["ITEM_DELETE"],
      conditions: [{ rel: "owns_resource" }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts a deny rule with an attr/op/value condition", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["ITEM_UPDATE"],
      conditions: [{ attr: "priority", op: "eq", value: "URGENT" }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an unconditional deny (empty conditions)", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["ITEM_DELETE"],
      conditions: [],
    });
    expect(r.success).toBe(true);
  });

  it("rejects effect: allow (v1 is deny-only; allow is inert in the engine)", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "allow",
      actions: ["ITEM_DELETE"],
      conditions: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects unbacked relationships (would fail closed for everyone)", () => {
    for (const rel of ["same_department", "is_manager_of_assignee"]) {
      const r = workRolePolicySchema.safeParse({
        effect: "deny",
        actions: ["ITEM_UPDATE"],
        conditions: [{ rel }],
      });
      expect(r.success, `rel=${rel}`).toBe(false);
    }
  });

  it("rejects an unknown action key", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["NOT_A_PERMISSION"],
      conditions: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty actions array (references nothing)", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: [],
      conditions: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown operator", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["ITEM_UPDATE"],
      conditions: [{ attr: "x", op: "regex", value: "y" }],
    });
    expect(r.success).toBe(false);
  });

  // value-type must match the operator class, else compare() fails open.
  it("rejects a set op (in/nin) with a SCALAR value (fail-open guard)", () => {
    for (const op of ["in", "nin"]) {
      const r = workRolePolicySchema.safeParse({
        effect: "deny",
        actions: ["ITEM_DELETE"],
        conditions: [{ attr: "createdById", op, value: "u1" }],
      });
      expect(r.success, `op=${op}`).toBe(false);
    }
  });

  it("rejects a scalar op (eq/ne) with an ARRAY value (fail-open guard)", () => {
    for (const op of ["eq", "ne"]) {
      const r = workRolePolicySchema.safeParse({
        effect: "deny",
        actions: ["ITEM_UPDATE"],
        conditions: [{ attr: "priority", op, value: ["URGENT"] }],
      });
      expect(r.success, `op=${op}`).toBe(false);
    }
  });

  it("accepts a set op (in) with a non-empty array", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["ITEM_DELETE"],
      conditions: [{ attr: "createdById", op: "in", value: ["u1", "u2"] }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a set op (in) with an empty array (matches nothing)", () => {
    const r = workRolePolicySchema.safeParse({
      effect: "deny",
      actions: ["ITEM_DELETE"],
      conditions: [{ attr: "createdById", op: "in", value: [] }],
    });
    expect(r.success).toBe(false);
  });
});

describe("work-role schemas carry policies", () => {
  it("workRolePoliciesSchema accepts an array of deny rules", () => {
    const r = workRolePoliciesSchema.safeParse([
      { effect: "deny", actions: ["ITEM_DELETE"], conditions: [{ rel: "owns_resource" }] },
      { effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ rel: "in_project" }] },
    ]);
    expect(r.success).toBe(true);
  });

  it("create schema defaults policies to []", () => {
    const r = workRoleCreateSchema.parse({ key: "contractor", name: "Contractor", grants: [] });
    expect(r.policies).toEqual([]);
  });

  it("update schema leaves policies undefined when omitted (name-only edit)", () => {
    const r = workRoleUpdateSchema.parse({ name: "Renamed" });
    expect(r.policies).toBeUndefined();
  });

  it("update schema accepts a policies array", () => {
    const r = workRoleUpdateSchema.safeParse({
      policies: [{ effect: "deny", actions: ["ITEM_DELETE"], conditions: [] }],
    });
    expect(r.success).toBe(true);
  });
});
