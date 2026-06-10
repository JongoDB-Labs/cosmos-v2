import { describe, expect, it } from "vitest";
import { Priority } from "@prisma/client";
import { buildWorkItemWhere, buildOrderBy } from "./build-where";
import { NO_CYCLE, UNASSIGNED, type WorkItemFilter } from "./filter";

const ORG = "org-1";
const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const P3 = "33333333-3333-3333-3333-333333333333";

function build(filter: WorkItemFilter, allowed: string[] = [P1, P2]) {
  return buildWorkItemWhere({ orgId: ORG, allowedProjectIds: allowed, filter });
}

describe("buildWorkItemWhere — RBAC project scoping", () => {
  it("always scopes to orgId + allowed projects", () => {
    const w = build({});
    expect(w.orgId).toBe(ORG);
    expect(w.projectId).toEqual({ in: [P1, P2] });
  });

  it("intersects requested projects with the allowed set (never widens)", () => {
    const w = build({ projectIds: [P2, P3] }); // P3 not allowed
    expect(w.projectId).toEqual({ in: [P2] });
  });

  it("an empty allowed set yields a match-nothing scope", () => {
    const w = build({}, []);
    expect(w.projectId).toEqual({ in: [] });
  });

  it("requesting only disallowed projects yields match-nothing", () => {
    const w = build({ projectIds: [P3] });
    expect(w.projectId).toEqual({ in: [] });
  });

  it("dedups + drops empty project ids", () => {
    const w = build({ projectIds: [P1, P1, ""] });
    expect(w.projectId).toEqual({ in: [P1] });
  });
});

describe("buildWorkItemWhere — simple field filters (AND across)", () => {
  it("type / status / priority are direct IN filters", () => {
    const w = build({
      typeIds: ["t1", "t2"],
      columnKeys: ["todo", "in-progress"],
      priorities: [Priority.HIGH, Priority.CRITICAL],
    });
    expect(w.workItemTypeId).toEqual({ in: ["t1", "t2"] });
    expect(w.columnKey).toEqual({ in: ["todo", "in-progress"] });
    expect(w.priority).toEqual({ in: [Priority.HIGH, Priority.CRITICAL] });
  });

  it("labels use hasSome (has-any)", () => {
    const w = build({ labels: ["backend", "urgent"] });
    expect(w.tags).toEqual({ hasSome: ["backend", "urgent"] });
  });

  it("omitted fields are inert", () => {
    const w = build({});
    expect(w.workItemTypeId).toBeUndefined();
    expect(w.columnKey).toBeUndefined();
    expect(w.priority).toBeUndefined();
    expect(w.tags).toBeUndefined();
    expect(w.AND).toBeUndefined();
  });

  it("empty arrays are inert", () => {
    const w = build({ typeIds: [], columnKeys: [], labels: [], priorities: [] });
    expect(w.workItemTypeId).toBeUndefined();
    expect(w.columnKey).toBeUndefined();
    expect(w.tags).toBeUndefined();
    expect(w.priority).toBeUndefined();
  });
});

describe("buildWorkItemWhere — assignee (incl. unassigned sentinel)", () => {
  it("single real assignee → equality-ish IN", () => {
    const w = build({ assigneeIds: ["u1"] });
    expect(w.assigneeId).toEqual({ in: ["u1"] });
    expect(w.AND).toBeUndefined();
  });

  it("only unassigned → assigneeId null", () => {
    const w = build({ assigneeIds: [UNASSIGNED] });
    expect(w.assigneeId).toBeNull();
  });

  it("real + unassigned → OR in AND clause", () => {
    const w = build({ assigneeIds: ["u1", "u2", UNASSIGNED] });
    expect(w.assigneeId).toBeUndefined();
    expect(w.AND).toEqual([
      { OR: [{ assigneeId: { in: ["u1", "u2"] } }, { assigneeId: null }] },
    ]);
  });
});

describe("buildWorkItemWhere — cycle (incl. none sentinel)", () => {
  it("real cycles → IN", () => {
    const w = build({ cycleIds: ["c1"] });
    expect(w.cycleId).toEqual({ in: ["c1"] });
  });

  it("only none → cycleId null", () => {
    const w = build({ cycleIds: [NO_CYCLE] });
    expect(w.cycleId).toBeNull();
  });

  it("real + none → OR", () => {
    const w = build({ cycleIds: ["c1", NO_CYCLE] });
    expect(w.AND).toEqual([
      { OR: [{ cycleId: { in: ["c1"] } }, { cycleId: null }] },
    ]);
  });
});

describe("buildWorkItemWhere — parent / hierarchy", () => {
  it("has_parent → not null", () => {
    expect(build({ parent: { mode: "has_parent" } }).parentId).toEqual({ not: null });
  });
  it("no_parent → null", () => {
    expect(build({ parent: { mode: "no_parent" } }).parentId).toBeNull();
  });
  it("is → IN specific parents", () => {
    expect(build({ parent: { mode: "is", parentIds: ["a", "b"] } }).parentId).toEqual({
      in: ["a", "b"],
    });
  });
  it("any → inert", () => {
    expect(build({ parent: { mode: "any" } }).parentId).toBeUndefined();
  });
});

describe("buildWorkItemWhere — date ranges", () => {
  it("start range with both edges → gte/lte (to is clamped to end-of-day)", () => {
    const w = build({ startDate: { from: "2026-01-01", to: "2026-02-01" } });
    // A date-only `to` is inclusive of the whole day, so buildDateRange clamps
    // it to 23:59:59.999Z — otherwise items dated later on 2026-02-01 would be
    // excluded from a range whose upper bound IS 2026-02-01.
    expect(w.startDate).toEqual({
      gte: new Date("2026-01-01"),
      lte: new Date("2026-02-01T23:59:59.999Z"),
    });
  });
  it("due range with only from → gte", () => {
    const w = build({ dueDate: { from: "2026-06-01" } });
    expect(w.dueDate).toEqual({ gte: new Date("2026-06-01") });
  });
  it("invalid date string is ignored (not thrown)", () => {
    const w = build({ dueDate: { from: "not-a-date" } });
    expect(w.dueDate).toBeUndefined();
  });
  it("empty range → inert", () => {
    const w = build({ startDate: {} });
    expect(w.startDate).toBeUndefined();
  });
});

describe("buildWorkItemWhere — free text (title OR description)", () => {
  it("text → AND clause with insensitive contains over title/description", () => {
    const w = build({ text: "login bug" });
    expect(w.AND).toEqual([
      {
        OR: [
          { title: { contains: "login bug", mode: "insensitive" } },
          { description: { contains: "login bug", mode: "insensitive" } },
        ],
      },
    ]);
  });
  it("whitespace-only text is inert", () => {
    expect(build({ text: "   " }).AND).toBeUndefined();
  });
  it("text + an assignee-OR both land in AND", () => {
    const w = build({ text: "x", assigneeIds: ["u1", UNASSIGNED] });
    expect(Array.isArray(w.AND)).toBe(true);
    expect((w.AND as unknown[]).length).toBe(2);
  });
});

describe("buildOrderBy", () => {
  it("defaults to createdAt desc", () => {
    expect(buildOrderBy(undefined)).toEqual([{ createdAt: "desc" }]);
  });
  it("priority asc keeps a stable secondary key", () => {
    expect(buildOrderBy({ field: "priority", direction: "asc" })).toEqual([
      { priority: "asc" },
      { createdAt: "desc" },
    ]);
  });
  it("dueDate desc", () => {
    expect(buildOrderBy({ field: "dueDate", direction: "desc" })).toEqual([
      { dueDate: "desc" },
      { createdAt: "desc" },
    ]);
  });
  it("ticketNumber asc", () => {
    expect(buildOrderBy({ field: "ticketNumber", direction: "asc" })).toEqual([
      { ticketNumber: "asc" },
      { createdAt: "desc" },
    ]);
  });
});
