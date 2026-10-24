// (e2e DB) POST work-items/aggregate: grouped counts and sums over a CQL
// query, scoped exactly like search (query design §5, §12.2).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { withCqlEnabled } from "../flag";
import type { AggRow } from "../aggregate";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { POST as aggregateRoute } from "@/app/api/v1/orgs/[orgId]/work-items/aggregate/route";

type Body = { rows: AggRow[]; total: number; truncated: boolean; cql: string };

describe("POST work-items/aggregate (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    getAuthContext.mockImplementation(async () => w.ctx());
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const call = async (body: unknown, ctx?: AuthContext) => {
    if (ctx) getAuthContext.mockImplementationOnce(async () => ctx);
    const res = await aggregateRoute(
      new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/work-items/aggregate`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ orgId: w.orgA }) },
    );
    const text = await res.text();
    // Gate refusals (404 / 401) are plain text.
    return { status: res.status, body: (text.startsWith("{") ? JSON.parse(text) : {}) as Body };
  };
  const sys = (id: string) => ({ field: { kind: "sys", id } });
  const p1 = () => ({ kind: "cql", cql: `project = ${w.P1.key}` });
  /** label → value, for one-dimension results. */
  const byLabel = (b: Body) => Object.fromEntries(b.rows.map((r) => [r.keys[0].label, r.value]));

  it("counts by status category, every readable active item in exactly one", async () => {
    const { status, body } = await call({ source: p1(), dims: [sys("statusCategory")] });
    expect(status).toBe(200);
    // login-bug in progress, coowned in review (in progress), unassigned todo, done done, child cancelled; archived hidden.
    expect(byLabel(body)).toEqual({ "In progress": 2, "To do": 1, Done: 1, Cancelled: 1 });
    expect(body.total).toBe(5);
    expect(body.rows.reduce((n, r) => n + r.count, 0)).toBe(5);
  });

  it("a cancelled item is Cancelled even with a completion date, and in one category only", async () => {
    await prisma.workItem.create({
      data: {
        orgId: w.orgA, projectId: w.P3.id, ticketNumber: 900, title: "p3-cancelled-done", description: "", columnKey: "cancelled",
        completedAt: new Date("2026-10-12T00:00:00Z"), workItemTypeId: w.typeTask, createdById: w.actor.id,
      },
    });
    const { body } = await call({ source: { kind: "cql", cql: `project = ${w.P3.key}` }, dims: [sys("statusCategory")] });
    expect(byLabel(body)).toEqual({ "To do": 1, Cancelled: 1 });
  });

  it("assignee is the primary or any co-assignee, with an Unassigned group", async () => {
    const { body } = await call({ source: p1(), dims: [sys("assignee")] });
    // Ada: login-bug. Bob: done (primary) + coowned (co-assignee). Unassigned: unassigned, child.
    expect(byLabel(body)).toEqual({ "Bob Builder": 2, "Ada Actor": 1, Unassigned: 2 });
    const none = body.rows.find((r) => r.keys[0].label === "Unassigned")!;
    expect(none.keys[0].id).toBeNull();
  });

  it("sums a number field; items without one count but add nothing", async () => {
    const { body } = await call({ source: p1(), dims: [sys("priority")], measure: { fn: "sum", field: { kind: "sys", id: "points" } } });
    const critical = body.rows.find((r) => r.keys[0].id === "CRITICAL")!;
    expect(critical).toMatchObject({ value: 5, count: 1, keys: [{ id: "CRITICAL", label: "Critical" }] });
    expect(body.rows.find((r) => r.keys[0].id === "LOW")).toMatchObject({ value: 0, count: 1 });
  });

  it("two dimensions are a cross tab", async () => {
    const { body } = await call({ source: p1(), dims: [sys("priority"), sys("statusCategory")] });
    const cell = (p: string, c: string) => body.rows.find((r) => r.keys[0].id === p && r.keys[1].id === c)?.value ?? 0;
    expect(cell("CRITICAL", "IN_PROGRESS")).toBe(1);
    expect(cell("HIGH", "IN_PROGRESS")).toBe(1);
    expect(cell("MEDIUM", "DONE")).toBe(1);
    expect(cell("LOW", "TODO")).toBe(1);
    expect(body.rows.reduce((n, r) => n + r.count, 0)).toBe(5);
  });

  it("never counts what the viewer can't read; an admin's numbers include it", async () => {
    const q = { source: { kind: "cql", cql: "priority = CRITICAL" }, dims: [sys("project")] };
    // The member reads P1 and P3; P2 is team-scoped and they aren't on it.
    const member = await call(q);
    expect(member.body.total).toBe(2);
    expect(member.body.rows.map((r) => r.keys[0].label).sort()).toEqual(["Project PA", "Project PC"]);
    expect(JSON.stringify(member.body)).not.toContain(`Secretproject ${w.stamp}`);
    expect(JSON.stringify(member.body)).not.toContain(w.P2.id);
    const admin = await call(q, w.ctx({ role: OrgRole.ADMIN }));
    expect(admin.body.total).toBe(3);
    expect(admin.body.rows.map((r) => r.keys[0].label).sort()).toEqual(["Project PA", "Project PC", `Secretproject ${w.stamp}`].sort());
  });

  it("labels group by label, an item once per label", async () => {
    const { body } = await call({ source: p1(), dims: [sys("label")] });
    expect(byLabel(body)).toEqual({ auth: 1, urgent: 1, "No labels": 3 });
  });

  it("a date dimension buckets in the request's time zone, in time order", async () => {
    const { body } = await call({ source: p1(), dims: [{ field: { kind: "sys", id: "completed" }, bucket: "month" }], tz: "America/Chicago" });
    expect(body.rows.map((r) => [r.keys[0].label, r.value])).toEqual([["2026-10", 1], ["No date", 4]]);
    // Completed at 12:00 UTC on the 10th, which is already the 11th at UTC+14.
    const day = async (tz: string) =>
      (await call({ source: { kind: "cql", cql: `${p1().cql} AND completed IS NOT EMPTY` }, dims: [{ field: { kind: "sys", id: "completed" }, bucket: "day" }], tz })).body.rows.map((r) => r.keys[0].label);
    expect(await day("UTC")).toEqual(["2026-10-10"]);
    expect(await day("Pacific/Kiritimati")).toEqual(["2026-10-11"]);
  });

  it("a saved filter is a source, if the viewer can see it", async () => {
    const view = await prisma.savedView.create({
      data: {
        orgId: w.orgA, ownerId: w.actor.id, name: `agg ${w.stamp}`, filter: {}, visibility: "PRIVATE",
        query: { v: 1, where: { op: "cmp", field: { kind: "sys", id: "project" }, cmp: "eq", value: { t: "ref", entity: "project", id: w.P1.id } } },
      },
    });
    // Its stored query (P1's five), not everything the viewer reads.
    expect((await call({ source: { kind: "savedFilter", id: view.id }, dims: [] })).body.total).toBe(5);
    expect((await call({ source: { kind: "cql", query: { v: 1, where: null } }, dims: [] })).body.total).toBeGreaterThan(5);
    // Someone else's private filter: not found, as if it didn't exist.
    expect((await call({ source: { kind: "savedFilter", id: view.id }, dims: [] }, { ...w.ctx(), userId: w.bob.id } as AuthContext)).status).toBe(404);
  });

  it("refuses what it can't group or measure, as a 400 that says why", async () => {
    const bad = await call({ source: p1(), dims: [sys("summary")] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/Can't group by `summary`/);
    expect((await call({ source: p1(), dims: [sys("priority"), sys("team"), sys("type")] })).status).toBe(400);
    expect((await call({ source: { kind: "cql", cql: "priorty = HIGH" }, dims: [] })).status).toBe(400);
  });

  it("404s while the org's query language is switched off", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      expect((await call({ source: p1(), dims: [] })).status).toBe(404);
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });
});
