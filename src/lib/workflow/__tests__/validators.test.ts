import { describe, it, expect } from "vitest";
import { runValidators, type ValidationFacts } from "../validators";
import type { ConditionItem } from "../conditions";

const item = (fields: Record<string, unknown> = {}, customFields: Record<string, unknown> = {}): ConditionItem => ({
  createdById: "bob",
  assigneeIds: [],
  teamId: null,
  fields: { resolution: null, intervalId: null, ...fields },
  customFields,
});

const DONE = new Set(["done"]);
const CANCELLED = new Set(["cancelled"]);

describe("runValidators", () => {
  it("fieldsRequired names exactly the fields still empty", () => {
    const failures = runValidators(
      [{ kind: "fieldsRequired", fields: [{ system: "resolution" }, { custom: "root_cause" }, { custom: "area" }] }],
      item({}, { area: "auth" }),
      {},
    );
    expect(failures).toEqual([
      expect.objectContaining({ validator: "fieldsRequired", fields: [{ system: "resolution" }, { custom: "root_cause" }] }),
    ]);
  });

  it("childrenSettled blocks on open children, not on done or cancelled ones (the Kanban guard, server-side)", () => {
    const facts = (columnKeys: string[]): ValidationFacts => ({
      children: {
        items: columnKeys.map((k, i) => ({ id: String(i), title: `Child ${i}`, columnKey: k })),
        doneKeys: DONE,
        cancelledKeys: CANCELLED,
      },
    });
    expect(runValidators([{ kind: "childrenSettled" }], item(), facts(["done", "cancelled"]))).toEqual([]);
    expect(runValidators([{ kind: "childrenSettled" }], item(), facts(["done", "doing"]))[0].message).toContain("Child 1");
  });

  it("wipLimit fails only above the limit, and only when some board holds the column to a hard limit", () => {
    const v = [{ kind: "wipLimit" as const, scope: "board" as const, hard: true as const }];
    expect(runValidators(v, item(), { wip: { limit: 3, countAfter: 3, columnName: "Doing", boardName: "Delivery" } })).toEqual([]);
    expect(runValidators(v, item(), { wip: { limit: 3, countAfter: 4, columnName: "Doing", boardName: "Delivery" } })[0].message).toBe('"Doing" on Delivery is at its WIP limit (3) — move blocked.');
    expect(runValidators(v, item(), {})).toEqual([]);
  });

  it("intervalRequired applies to stories in a project that plans in intervals", () => {
    const v = [{ kind: "intervalRequired" as const }];
    expect(runValidators(v, item(), { interval: { typeKey: "software.story", projectHasIntervals: true } })).toHaveLength(1);
    expect(runValidators(v, item({ intervalId: "s1" }), { interval: { typeKey: "software.story", projectHasIntervals: true } })).toEqual([]);
    expect(runValidators(v, item(), { interval: { typeKey: "software.task", projectHasIntervals: true } })).toEqual([]);
  });

  it("cancelReason keeps today's rule: optional, but Other needs a note", () => {
    const v = [{ kind: "cancelReason" as const }];
    expect(runValidators(v, item(), { cancel: { reason: null, note: null } })).toEqual([]);
    expect(runValidators(v, item(), { cancel: { reason: "OTHER", note: "  " } })).toHaveLength(1);
    expect(runValidators(v, item(), { cancel: { reason: "OTHER", note: "why" } })).toEqual([]);
  });

  it("fails closed when a needed fact was not loaded", () => {
    expect(runValidators([{ kind: "childrenSettled" }], item(), {})).toHaveLength(1);
    expect(runValidators([{ kind: "linksSettled", linkType: "BLOCKED_BY" }], item(), {})).toHaveLength(1);
    expect(runValidators([{ kind: "intervalRequired" }], item(), {})).toHaveLength(1);
  });

  it("a field validator fails on a missing field and carries its message", () => {
    const v = [{ kind: "field" as const, field: { custom: "severity" }, op: "lte" as const, value: 2, message: "Sev 3+ needs a review." }];
    expect(runValidators(v, item({}, { severity: 3 }), {})).toEqual([{ validator: "field", message: "Sev 3+ needs a review." }]);
    expect(runValidators(v, item(), {})).toHaveLength(1);
    expect(runValidators(v, item({}, { severity: "1" }), {})).toEqual([]);
  });
});
