import { describe, expect, it } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import {
  evaluateAccess,
  coerceRules,
  type AbacRule,
  type EvaluateAccessArgs,
} from "./engine";

const HAS = Permission.EXPENSE_APPROVE; // base = true for EXPENSE_APPROVE
const NONE = 0n; // base = false

function args(over: Partial<EvaluateAccessArgs>): EvaluateAccessArgs {
  return {
    effectivePermissions: HAS,
    action: "EXPENSE_APPROVE",
    rules: [],
    ...over,
  };
}

const denyHighValue: AbacRule = {
  effect: "deny",
  actions: ["EXPENSE_APPROVE"],
  conditions: [{ attr: "amount", op: "gt", value: 5000 }],
};
const denyOwn: AbacRule = {
  effect: "deny",
  actions: ["EXPENSE_APPROVE"],
  conditions: [{ rel: "owns_resource" }],
};

describe("evaluateAccess — fall-through (backwards compatible)", () => {
  it("base true, no rules → true", () => expect(evaluateAccess(args({}))).toBe(true));
  it("base false, no rules → false", () =>
    expect(evaluateAccess(args({ effectivePermissions: NONE }))).toBe(false));
  it("rules not referencing the action are ignored", () => {
    const other: AbacRule = { effect: "deny", actions: ["ITEM_DELETE"], conditions: [] };
    expect(evaluateAccess(args({ rules: [other] }))).toBe(true);
  });
  it("unknown action fails closed", () => {
    expect(
      evaluateAccess(args({ action: "NOPE" as never, effectivePermissions: HAS })),
    ).toBe(false);
  });
});

describe("evaluateAccess — no escalation (R-2/R-10)", () => {
  it("base false can never be granted by any rule", () => {
    expect(
      evaluateAccess(args({ effectivePermissions: NONE, resource: { amount: 1 }, rules: [denyHighValue] })),
    ).toBe(false);
  });
  it("allow rules are INERT in v1 — never grant beyond the bitfield", () => {
    const allow: AbacRule = {
      effect: "allow",
      actions: ["EXPENSE_APPROVE"],
      conditions: [{ attr: "amount", op: "lte", value: 5000 }],
    };
    expect(evaluateAccess(args({ effectivePermissions: NONE, resource: { amount: 1 }, rules: [allow] }))).toBe(false);
    // ...and never narrow either (base true stays true with only an allow present)
    expect(evaluateAccess(args({ resource: { amount: 9999 }, rules: [allow] }))).toBe(true);
  });
});

describe("evaluateAccess — OWNER break-glass (R-5)", () => {
  it("owner bypasses a firing deny and a missing base bit", () => {
    expect(
      evaluateAccess(
        args({ isOwner: true, effectivePermissions: NONE, actorUserId: "u1", resource: { createdById: "u1" }, rules: [denyOwn] }),
      ),
    ).toBe(true);
  });
});

describe("evaluateAccess — DENY fails CLOSED on unresolvable (the fix)", () => {
  it("deny over a missing attribute FIRES (capability-only check, no resource)", () => {
    expect(evaluateAccess(args({ rules: [denyHighValue] }))).toBe(false);
  });
  it("deny over a resource lacking the attribute FIRES", () => {
    expect(evaluateAccess(args({ resource: { vendor: "x" }, rules: [denyHighValue] }))).toBe(false);
  });
  it("deny does NOT fire only when a condition is DEFINITIVELY false", () => {
    expect(evaluateAccess(args({ resource: { amount: 100 }, rules: [denyHighValue] }))).toBe(true);
  });
  it("deny fires when the condition holds", () => {
    expect(evaluateAccess(args({ resource: { amount: 10000 }, rules: [denyHighValue] }))).toBe(false);
  });
  it("ne over a missing attribute is unresolvable → deny FIRES (no lockout-flip)", () => {
    const denyNe: AbacRule = {
      effect: "deny",
      actions: ["EXPENSE_APPROVE"],
      conditions: [{ attr: "status", op: "ne", value: "ARCHIVED" }],
    };
    expect(evaluateAccess(args({ resource: { amount: 1 }, rules: [denyNe] }))).toBe(false);
  });
  it("empty actions reference nothing → deny does not block", () => {
    const stray: AbacRule = { effect: "deny", actions: [], conditions: [] };
    expect(evaluateAccess(args({ rules: [stray] }))).toBe(true);
  });
});

describe("evaluateAccess — numeric coercion (deny can't silently no-op)", () => {
  it("string-encoded resource attribute still compares numerically", () => {
    expect(evaluateAccess(args({ resource: { amount: "10000" }, rules: [denyHighValue] }))).toBe(false);
    expect(evaluateAccess(args({ resource: { amount: "100" }, rules: [denyHighValue] }))).toBe(true);
  });
  it("string-encoded rule value compares numerically", () => {
    const denyStrVal: AbacRule = {
      effect: "deny",
      actions: ["EXPENSE_APPROVE"],
      conditions: [{ attr: "amount", op: "gt", value: "5000" as never }],
    };
    expect(evaluateAccess(args({ resource: { amount: 9999 }, rules: [denyStrVal] }))).toBe(false);
  });
});

describe("evaluateAccess — operators (present values)", () => {
  const mk = (cond: AbacRule["conditions"][number]) =>
    args({ resource: { priority: "HIGH", amount: 50, tags: ["a", "b"] }, rules: [{ effect: "deny", actions: ["EXPENSE_APPROVE"], conditions: [cond] }] });
  it("eq fires", () => expect(evaluateAccess(mk({ attr: "priority", op: "eq", value: "HIGH" }))).toBe(false));
  it("eq present-but-false → allowed", () => expect(evaluateAccess(mk({ attr: "priority", op: "eq", value: "LOW" }))).toBe(true));
  it("in", () => expect(evaluateAccess(mk({ attr: "priority", op: "in", value: ["HIGH"] }))).toBe(false));
  it("nin present-but-true", () => expect(evaluateAccess(mk({ attr: "priority", op: "nin", value: ["LOW"] }))).toBe(false));
  it("lte boundary", () => expect(evaluateAccess(mk({ attr: "amount", op: "lte", value: 50 }))).toBe(false));
  it("contains array", () => expect(evaluateAccess(mk({ attr: "tags", op: "contains", value: "a" }))).toBe(false));
});

describe("evaluateAccess — relationships", () => {
  it("owns_resource match → deny fires", () =>
    expect(evaluateAccess(args({ actorUserId: "u1", resource: { createdById: "u1" }, rules: [denyOwn] }))).toBe(false));
  it("owns_resource present-no-match → allowed", () =>
    expect(evaluateAccess(args({ actorUserId: "u1", resource: { createdById: "u2" }, rules: [denyOwn] }))).toBe(true));
  it("owns_resource unresolvable (no actor) → deny fires (fail-closed)", () =>
    expect(evaluateAccess(args({ resource: { createdById: "u1" }, rules: [denyOwn] }))).toBe(false));
  it("in_project: resolved true → deny fires; false → allowed; unresolved → fires", () => {
    const d: AbacRule = { effect: "deny", actions: ["EXPENSE_APPROVE"], conditions: [{ rel: "in_project" }] };
    expect(evaluateAccess(args({ relationships: { in_project: true }, rules: [d] }))).toBe(false);
    expect(evaluateAccess(args({ relationships: { in_project: false }, rules: [d] }))).toBe(true);
    expect(evaluateAccess(args({ rules: [d] }))).toBe(false); // unresolved → fail-closed
  });
});

describe("evaluateAccess — attribute path safety (R-6)", () => {
  it("prototype-polluting path resolves to undefined (deny fires, never reads prototype)", () => {
    const deny: AbacRule = { effect: "deny", actions: ["EXPENSE_APPROVE"], conditions: [{ attr: "__proto__.x", op: "eq", value: true }] };
    expect(evaluateAccess(args({ resource: { amount: 1 }, rules: [deny] }))).toBe(false);
  });
});

describe("coerceRules (R-7 + crash-hardening)", () => {
  const valid: AbacRule = { effect: "deny", actions: ["ORG_READ"], conditions: [] };
  it("passes a valid array", () => expect(coerceRules([valid])).toEqual([valid]));
  it("empty object default {} → []", () => expect(coerceRules({})).toEqual([]));
  it("wrapping { rules: [...] }", () => expect(coerceRules({ rules: [valid] })).toEqual([valid]));
  it("drops malformed: bad effect, non-string action, invalid condition", () => {
    expect(
      coerceRules([
        valid,
        { effect: "nope", actions: ["ORG_READ"], conditions: [] },
        { effect: "deny", actions: [123], conditions: [] },
        { effect: "deny", actions: ["ORG_READ"], conditions: [{ op: "eq", value: 1 }] }, // attr missing
        { effect: "deny", actions: ["ORG_READ"], conditions: [{ rel: "bogus" }] },
        null,
      ]),
    ).toEqual([valid]);
  });
  it("non-array/object → []", () => {
    expect(coerceRules("x")).toEqual([]);
    expect(coerceRules(null)).toEqual([]);
  });
});

describe("evaluateAccess — type-mismatched operand fails CLOSED (regression)", () => {
  // Pre-fix, a malformed operand made compare() return false → the condition
  // read as "definitively false" → the DENY silently no-opped (fail-OPEN).
  // It must now be treated as unresolvable so the deny fires (fail-CLOSED).
  it("set op (in) with a SCALAR value → deny still fires (denied)", () => {
    const deny: AbacRule = {
      effect: "deny",
      actions: ["EXPENSE_APPROVE"],
      conditions: [{ attr: "category", op: "in", value: "travel" }],
    };
    expect(
      evaluateAccess(args({ resource: { category: "travel" }, rules: [deny] })),
    ).toBe(false);
  });

  it("scalar op (eq) with an ARRAY value → deny still fires (denied)", () => {
    const deny: AbacRule = {
      effect: "deny",
      actions: ["EXPENSE_APPROVE"],
      conditions: [{ attr: "category", op: "eq", value: ["travel"] }],
    };
    expect(
      evaluateAccess(args({ resource: { category: "travel" }, rules: [deny] })),
    ).toBe(false);
  });

  it("well-typed set op (in) with an array still evaluates normally", () => {
    const deny: AbacRule = {
      effect: "deny",
      actions: ["EXPENSE_APPROVE"],
      conditions: [{ attr: "category", op: "in", value: ["travel", "meals"] }],
    };
    // in-set → condition true → deny fires → denied
    expect(
      evaluateAccess(args({ resource: { category: "travel" }, rules: [deny] })),
    ).toBe(false);
    // out-of-set → condition definitively false → deny does NOT fire → allowed
    expect(
      evaluateAccess(args({ resource: { category: "office" }, rules: [deny] })),
    ).toBe(true);
  });
});
