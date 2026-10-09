import { describe, expect, it } from "vitest";
import {
  finishUniqueRead,
  isFilterable,
  isUniqueRead,
  planUniqueRead,
  withActiveFilter,
} from "./active-org-members";

/**
 * Removing someone from an org retains their `org_members` row with `removedAt` set, so
 * their history stays attributable. The property that makes that safe is here: a
 * removed membership must not satisfy a membership read.
 *
 * It is enforced centrally because ~67 call sites — every RBAC and auth path included —
 * would otherwise each have to remember, and a miss grants a removed person continued
 * access while every feature still appears to work.
 */
describe("withActiveFilter — filter-shaped operations", () => {
  it("narrows a bare call to current members", () => {
    expect(withActiveFilter(undefined)).toEqual({ where: { removedAt: null } });
  });

  it("keeps the caller's own conditions", () => {
    expect(withActiveFilter({ where: { orgId: "o1" }, take: 5 })).toEqual({
      where: { orgId: "o1", removedAt: null },
      take: 5,
    });
  });

  it("does not mutate the caller's args", () => {
    const args = { where: { orgId: "o1" } };
    withActiveFilter(args);
    expect(args).toEqual({ where: { orgId: "o1" } });
  });

  it("covers the operations that take a filter, and no others", () => {
    for (const op of [
      "findMany",
      "findFirst",
      "findFirstOrThrow",
      "count",
      "aggregate",
      "groupBy",
      "updateMany",
      "deleteMany",
    ]) {
      expect(isFilterable(op), op).toBe(true);
    }
    // `update`/`delete`/`upsert` address a row by unique key, which does not accept a
    // non-unique `removedAt` clause — Prisma rejects it as invalid input. Membership
    // lifecycle owns those, and `create` has no `where` to narrow.
    for (const op of ["update", "delete", "upsert", "create", "createMany", "findUnique"]) {
      expect(isFilterable(op), op).toBe(false);
    }
  });
});

describe("planUniqueRead — making the row judgeable", () => {
  it("adds removedAt to a select that omits it", () => {
    // THE case the design turns on: loadEffectivePermissions — the gate deciding
    // whether a request gets an AuthContext at all — selects role/permissions/abacRules
    // and no removedAt. Without this injection the row comes back with nothing to judge
    // and every removed member reads as a current one.
    const plan = planUniqueRead({ where: { id: "m1" }, select: { role: true } });
    expect(plan.args.select).toEqual({ role: true, removedAt: true });
    expect(plan.injected).toBe(true);
  });

  it("leaves a select that already asks for removedAt alone", () => {
    const plan = planUniqueRead({ select: { id: true, removedAt: true } });
    expect(plan.args.select).toEqual({ id: true, removedAt: true });
    expect(plan.injected).toBe(false);
  });

  it("un-omits removedAt when the caller omitted it", () => {
    const plan = planUniqueRead({ omit: { removedAt: true, permissions: true } });
    expect(plan.args.omit).toEqual({ permissions: true });
    expect(plan.injected).toBe(true);
  });

  it("needs no injection when no projection is given — all scalars come back", () => {
    const plan = planUniqueRead({ where: { id: "m1" } });
    expect(plan.injected).toBe(false);
    expect(plan.args).toEqual({ where: { id: "m1" } });
  });

  it("does not mutate the caller's args", () => {
    const args = { select: { role: true } };
    planUniqueRead(args);
    expect(args).toEqual({ select: { role: true } });
  });
});

describe("finishUniqueRead — judging the row", () => {
  it("reports a removed member as absent", () => {
    const verdict = finishUniqueRead({ id: "m1", removedAt: new Date() }, false);
    expect(verdict).toEqual({ removed: true, row: null });
  });

  it("passes a current member through", () => {
    const row = { id: "m1", removedAt: null };
    expect(finishUniqueRead(row, false)).toEqual({ removed: false, row });
  });

  it("passes a genuine miss through as a miss, not a removal", () => {
    expect(finishUniqueRead(null, false)).toEqual({ removed: false, row: null });
  });

  it("strips an injected removedAt so the caller's result shape is what it asked for", () => {
    const verdict = finishUniqueRead({ role: "MEMBER", removedAt: null }, true);
    expect(verdict.row).toEqual({ role: "MEMBER" });
    expect(verdict.row).not.toHaveProperty("removedAt");
  });

  it("keeps removedAt when the caller asked for it themselves", () => {
    const verdict = finishUniqueRead({ id: "m1", removedAt: null }, false);
    expect(verdict.row).toHaveProperty("removedAt", null);
  });

  it("treats an epoch timestamp as removed", () => {
    // Guards the VALUE, not the null-check: a Date is truthy whatever instant it
    // holds, so `!= null` and a bare truthiness test agree here. Worth pinning anyway
    // — epoch-zero has been read as "unset" elsewhere in this codebase.
    expect(finishUniqueRead({ id: "m1", removedAt: new Date(0) }, false).removed).toBe(true);
  });

  it("treats an ABSENT removedAt as present, not removed", () => {
    // `!= null` has to catch undefined as well as null. A `=== null` check would read
    // a row whose projection left removedAt out as REMOVED and deny a current member
    // — the filter failing closed, locking out the whole org.
    expect(finishUniqueRead({ id: "m1" }, false)).toEqual({ removed: false, row: { id: "m1" } });
  });
});

describe("isUniqueRead", () => {
  it("covers both unique reads and nothing else", () => {
    expect(isUniqueRead("findUnique")).toBe(true);
    expect(isUniqueRead("findUniqueOrThrow")).toBe(true);
    expect(isUniqueRead("findFirst")).toBe(false);
    expect(isUniqueRead("update")).toBe(false);
  });
});
