// scripts/cutover/lib/reconcile-core.test.ts
//
// Pure unit tests for the final-reconcile delete-extras crux:
//   - computeExtras (the target-minus-source PK-set diff that decides what to delete)
//   - the model-graph eligibility + forbidden guards (NEVER append-only/audit/ROOT/MEMBER)
// No DB — these encode the HARD INVARIANTS that keep the reconcile from deleting the wrong thing.

import { describe, it, expect } from "vitest";
import { computeExtras } from "./reconcile-core";
import {
  buildModelPlans,
  deleteExtrasPlans,
  deleteForbiddenReason,
  AUDIT_APPEND_ONLY_TABLES,
  type ModelPlan,
} from "./model-graph";

describe("computeExtras — target-minus-source PK diff (what to delete)", () => {
  it("returns PKs in target but NOT in source (the lingering deletes)", () => {
    expect(computeExtras(["a", "b"], ["a", "b", "c", "d"])).toEqual(["c", "d"]);
  });

  it("returns [] when target ⊆ source (nothing deleted in source)", () => {
    expect(computeExtras(["a", "b", "c"], ["a", "b"])).toEqual([]);
  });

  it("a row in SOURCE but not target is NOT a delete candidate (that's an insert, not a delete)", () => {
    // source has x,y,z; target has x,y. z is source-only ⇒ NOT in extras (we only delete
    // target-minus-source). This is exactly the deduped-DataClassification case.
    expect(computeExtras(["x", "y", "z"], ["x", "y"])).toEqual([]);
  });

  it("preserves target order of the extras (deterministic)", () => {
    expect(computeExtras(["b"], ["c", "a", "b", "d"])).toEqual(["c", "a", "d"]);
  });

  it("empty source ⇒ ALL target rows are extras (first-ever reconcile against an empty source)", () => {
    expect(computeExtras([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("empty target ⇒ no extras (nothing to delete)", () => {
    expect(computeExtras(["a", "b"], [])).toEqual([]);
  });
});

describe("deleteExtrasPlans — eligibility (mutable ∩ org-owned ∩ non-audit)", () => {
  const plans = buildModelPlans();
  const eligible = deleteExtrasPlans(plans);
  const eligibleTables = new Set(eligible.map((p) => p.table));

  it("excludes ALL append-only tables (immutable history / audit)", () => {
    for (const p of plans) {
      if (p.appendOnly) expect(eligibleTables.has(p.table)).toBe(false);
    }
  });

  it("excludes the AUDIT tables explicitly", () => {
    for (const t of AUDIT_APPEND_ONLY_TABLES) {
      expect(eligibleTables.has(t)).toBe(false);
    }
  });

  it("excludes ROOT (organizations) and MEMBER (users) — never delete the tenant or shared users", () => {
    expect(eligibleTables.has("organizations")).toBe(false);
    expect(eligibleTables.has("users")).toBe(false);
  });

  it("includes only DIRECT/PARENT-scoped mutable tables", () => {
    for (const p of eligible) {
      expect(p.appendOnly).toBe(false);
      expect(["DIRECT", "PARENT"]).toContain(p.scope.kind);
    }
  });

  it("includes the expected core mutable org tables (work_items, notes, projects, revenues)", () => {
    for (const t of ["work_items", "notes", "projects", "revenues", "data_classifications"]) {
      expect(eligibleTables.has(t)).toBe(true);
    }
  });
});

describe("deleteForbiddenReason — the hard per-table guard", () => {
  const mk = (over: Partial<ModelPlan>): ModelPlan => ({
    model: "X",
    table: "x",
    pk: ["id"],
    appendOnly: false,
    updatedAtColumn: "updated_at",
    moneyColumns: [],
    scope: { kind: "DIRECT", orgIdColumn: "org_id" },
    ...over,
  });

  it("forbids an audit table BY NAME even if marked mutable (defense in depth)", () => {
    expect(deleteForbiddenReason(mk({ table: "audit_logs" }))).toMatch(/audit/);
    expect(deleteForbiddenReason(mk({ table: "egress_decisions" }))).toMatch(/audit/);
  });

  it("forbids an append-only table", () => {
    expect(deleteForbiddenReason(mk({ appendOnly: true, table: "chat_messages" }))).toMatch(/append-only/);
  });

  it("forbids ROOT (the tenant Organization row)", () => {
    expect(deleteForbiddenReason(mk({ scope: { kind: "ROOT" }, table: "organizations" }))).toMatch(/ROOT/);
  });

  it("forbids MEMBER (shared users — a closure parent, not org-owned)", () => {
    expect(deleteForbiddenReason(mk({ scope: { kind: "MEMBER" }, table: "users" }))).toMatch(/MEMBER/);
  });

  it("allows a normal mutable DIRECT org table (returns null)", () => {
    expect(deleteForbiddenReason(mk({ table: "work_items" }))).toBeNull();
  });

  it("allows a mutable PARENT-scoped org table", () => {
    expect(deleteForbiddenReason(mk({ table: "key_results", scope: { kind: "PARENT" } }))).toBeNull();
  });
});
