// @vitest-environment node
// (e2e DB) Every dashboard panel type, computed as a viewer in the CQL test
// world: restricted (P2), ABAC-denied (P3) and other-org (B) twins carry the
// same values as the readable items, so a scope bug shows up as a wrong row,
// count or name. Plus the filter bar, batch isolation and classification.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";
import { parseCql } from "@/lib/query/parser";
import { RESTRICTED } from "@/lib/query/saved-filters.server";
import { computePanels, type PanelResult, type PanelSpec } from "../panel-data.server";
import { PANEL_TYPE_KEYS } from "../panel-registry";
import { COMPUTES } from "../panel-compute.server";
import type { DashboardFilterDef } from "../filters";

let w: World;
const NOW = new Date("2026-10-12T15:00:00Z");
const q = (cql: string) => parseCql(cql).query;
const key = (n: string) => `${w.P1.key}-${w.items[n].ticketNumber}`;

async function run(spec: PanelSpec, extra: Partial<Parameters<typeof computePanels>[2]> = {}) {
  const [r] = await computePanels(w.ctx({ denyP3: true }), [spec], { tz: "UTC", now: NOW, ...extra });
  return r;
}
function ok(r: PanelResult) {
  if ("error" in r) throw new Error(`panel failed: ${r.error.code} ${r.error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows differ per panel type
  return r as { data: Record<string, unknown> & { rows?: any[] }; meta: { total: number | null; truncated: boolean; classification?: { level: string; markedRows: number } } };
}
const noSecrets = (r: PanelResult) => {
  const s = JSON.stringify(r);
  for (const secret of w.secrets) expect(s).not.toContain(secret);
  expect(s).not.toContain(`p3-denied-${w.stamp}`);
  expect(s).not.toContain(`b1-otherorg-${w.stamp}`);
};

beforeAll(async () => {
  w = await seedWorld();
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});

describe("the catalog", () => {
  it("every panel type has a compute", () => {
    for (const t of PANEL_TYPE_KEYS) expect(typeof COMPUTES[t], t).toBe("function");
  });
});

describe("lists", () => {
  it("item-list: the viewer's rows, with status and sprint names, classification for GOV, no twin", async () => {
    const r = await run({ type: "item-list", query: q("priority = CRITICAL"), config: {} });
    noSecrets(r);
    const { data, meta } = ok(r);
    const rows = data.rows as { key: string; status: string; sprint: { name: string }; classification?: { level: string } }[];
    expect(rows.map((x) => x.key)).toEqual([key("p1-login-bug")]);
    expect(rows[0].status).toBe("In Progress");
    expect(rows[0].sprint.name).toBe("Sprint 1");
    expect(rows[0].classification).toEqual({ level: "UNCLASSIFIED", marked: false });
    expect(meta).toMatchObject({ total: 1, truncated: false, classification: { level: "UNCLASSIFIED", markedRows: 0 } });
  });

  it("item-list groups by assignee", async () => {
    const { data } = ok(await run({ type: "item-list", query: q(`project = ${w.P1.key} AND statusCategory != DONE`), config: { groupBy: "assignee", limit: 50 } }));
    const groups = data.groups as { label: string; ids: string[] }[];
    expect(groups.find((g) => g.label === "Ada Actor")?.ids).toContain(w.items["p1-login-bug"].id);
    expect(groups.find((g) => g.label === "Unassigned")?.ids).toContain(w.items["p1-unassigned"].id);
  });

  it("blockers: what blocks each item; a blocker the viewer can't open is named as restricted", async () => {
    const link = await prisma.workItemLink.create({
      data: { orgId: w.orgA, sourceItemId: w.items[`p2-secret-${w.stamp}`].id, targetItemId: w.items["p1-unassigned"].id, type: "BLOCKS" },
    });
    try {
      const r = await run({ type: "blockers", query: q(`project = ${w.P1.key}`), config: {} });
      noSecrets(r);
      const rows = ok(r).data.rows as { key: string; blockedBy: { key: string; title: string }[] }[];
      const unassigned = rows.find((x) => x.key === key("p1-unassigned"))!;
      expect(unassigned.blockedBy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: key("p1-coowned"), title: "p1-coowned" }),
          expect.objectContaining({ key: RESTRICTED, title: RESTRICTED }),
        ]),
      );
    } finally {
      await prisma.workItemLink.delete({ where: { id: link.id } });
    }
  });

  it("my-work: assigned to the viewer and open; watching", async () => {
    const assigned = ok(await run({ type: "my-work", query: null, config: {} })).data.rows!;
    expect(assigned.map((x) => x.key)).toEqual([key("p1-login-bug")]);
    const watching = ok(await run({ type: "my-work", query: null, config: { mode: "watching" } })).data.rows!;
    expect(watching.map((x) => x.key)).toEqual([key("p1-login-bug")]);
  });

  it("due-soon: due within N working days and not done; overdue flagged", async () => {
    const soon = ok(await run({ type: "due-soon", query: null, config: { days: 10 } })).data.rows as { key: string; overdue: boolean }[];
    expect(soon).toEqual([expect.objectContaining({ key: key("p1-login-bug"), overdue: false })]);
    const later = await computePanels(w.ctx({ denyP3: true }), [{ type: "due-soon", query: null, config: { days: 1 } }], { tz: "UTC", now: new Date("2026-10-25T09:00:00Z") });
    expect(ok(later[0]).data.rows).toEqual([expect.objectContaining({ key: key("p1-login-bug"), overdue: true })]);
  });

  it("aging-wip: in-progress items, age in working days, toned by thresholds", async () => {
    await prisma.workItem.update({ where: { id: w.items["p1-login-bug"].id }, data: { columnEnteredAt: new Date("2026-10-01T09:00:00Z") } });
    const rows = ok(await run({ type: "aging-wip", query: q(`project = ${w.P1.key}`), config: { warnDays: 3, dangerDays: 7 } })).data.rows as {
      key: string; ageDays: number; tone: string;
    }[];
    const bug = rows.find((x) => x.key === key("p1-login-bug"))!;
    // Thu 1 Oct → Mon 12 Oct: 7 working days.
    expect(bug).toMatchObject({ ageDays: 7, tone: "danger" });
  });

  it("standup-walk: per person, done since the last standup, in progress, blocked or at risk", async () => {
    const r = await run({ type: "standup-walk", query: q(`project = ${w.P1.key}`), config: {} }, { sinceLastStandup: new Date("2026-10-09T00:00:00Z") });
    noSecrets(r);
    const people = ok(r).data.people as { name: string; done: { key: string }[]; inProgress: { key: string }[]; blocked: { key: string }[] }[];
    const by = (n: string) => people.find((p) => p.name === n)!;
    expect(by("Bob Builder").done.map((x) => x.key)).toEqual([key("p1-done")]);
    expect(by("Ada Actor").inProgress.map((x) => x.key)).toEqual([key("p1-login-bug")]);
    // RED highlight = at risk.
    expect(by("Ada Actor").blocked.map((x) => x.key)).toEqual([key("p1-login-bug")]);
    expect(by("Unassigned").blocked.map((x) => x.key)).toEqual([key("p1-unassigned")]);
    expect(people.at(-1)!.name).toBe("Unassigned");
  });

  it("changes-since and activity: recorded changes of the query's items only", async () => {
    const mine = await prisma.activity.create({
      data: { orgId: w.orgA, workItemId: w.items["p1-login-bug"].id, userId: w.bob.id, action: "updated", field: "columnKey", oldValue: "todo", newValue: "in-progress", createdAt: new Date("2026-10-11T10:00:00Z") },
    });
    const hidden = await prisma.activity.create({
      data: { orgId: w.orgA, workItemId: w.items[`p2-secret-${w.stamp}`].id, userId: w.bob.id, action: "updated", field: "columnKey", oldValue: "todo", newValue: "in-progress", createdAt: new Date("2026-10-11T10:00:00Z") },
    });
    try {
      const r = await run({ type: "changes-since", query: null, config: { since: "-7d" } });
      noSecrets(r);
      const changes = ok(r).data.changes as { id: string; by: string; item: { key: string } }[];
      expect(changes.map((c) => c.id)).toEqual([mine.id]);
      expect(changes[0]).toMatchObject({ by: "Bob Builder", item: { key: key("p1-login-bug") } });
      const act = ok(await run({ type: "activity", query: q("priority = CRITICAL"), config: {} })).data.changes as { id: string }[];
      expect(act.map((c) => c.id)).toContain(mine.id);
      expect(act.map((c) => c.id)).not.toContain(hidden.id);
    } finally {
      await prisma.activity.deleteMany({ where: { id: { in: [mine.id, hidden.id] } } });
    }
  });
});

describe("numbers and charts", () => {
  it("number: a count, its threshold tone; the twins never count", async () => {
    const { data, meta } = ok(await run({ type: "number", query: q("priority = CRITICAL"), config: { thresholds: [{ op: ">=", value: 1, tone: "danger" }] } }));
    expect(data).toMatchObject({ value: 1, tone: "danger" });
    expect(meta.classification).toEqual({ level: "UNCLASSIFIED", markedRows: 0 });
  });

  it("number: a sum of points", async () => {
    const { data } = ok(await run({ type: "number", query: q(`project = ${w.P1.key}`), config: { measure: { fn: "sum", field: { kind: "sys", id: "points" } } } }));
    expect(data.value).toBe(5);
  });

  it("kpi-row: each item its own query within the panel's", async () => {
    const { data } = ok(await run({ type: "kpi-row", query: q(`project = ${w.P1.key}`), config: { items: [{ label: "Critical", cql: "priority = CRITICAL" }, { label: "Done", cql: "statusCategory = DONE" }] } }));
    expect(data.items).toEqual([expect.objectContaining({ label: "Critical", value: 1 }), expect.objectContaining({ label: "Done", value: 1 })]);
  });

  it("breakdown, matrix and progress agree with plain counts", async () => {
    const b = ok(await run({ type: "breakdown", query: q(`project = ${w.P1.key}`), config: { field: { kind: "sys", id: "priority" } } })).data.rows as { keys: { id: string }[]; value: number }[];
    const crit = b.find((r) => r.keys[0].id === "CRITICAL")!;
    expect(crit.value).toBe(1);
    const m = ok(await run({ type: "matrix", query: q(`project = ${w.P1.key}`), config: { x: { kind: "sys", id: "priority" }, y: { kind: "sys", id: "statusCategory" } } })).data as { total: number; rowTotals: number[]; colTotals: number[] };
    expect(m.rowTotals.reduce((a, c) => a + c, 0)).toBe(m.total);
    expect(m.colTotals.reduce((a, c) => a + c, 0)).toBe(m.total);
    const p = ok(await run({ type: "progress", query: q(`project = ${w.P1.key}`), config: {} })).data as { total: number; done: number; percent: number };
    expect(p.done).toBe(1);
    expect(p.percent).toBe(Math.round((1 / p.total) * 100));
  });

  it("stacked, workload and created-vs-resolved run", async () => {
    expect("error" in (await run({ type: "stacked", query: q(`project = ${w.P1.key}`), config: {} }))).toBe(false);
    const wl = ok(await run({ type: "workload", query: q(`project = ${w.P1.key}`), config: { unit: "count" } })).data.rows as { keys: { label: string }[]; value: number }[];
    expect(wl.find((r) => r.keys[0].label === "Ada Actor")?.value).toBe(1);
    const cvr = ok(await run({ type: "created-vs-resolved", query: q(`project = ${w.P1.key}`), config: { window: "-30d", bucket: "day" } })).data as { points: { resolved: number }[] };
    expect(cvr.points.reduce((s, p) => s + p.resolved, 0)).toBe(1);
  });
});

describe("sprint and flow", () => {
  it("burndown and sprint-status pick the open sprint most items are in", async () => {
    const b = ok(await run({ type: "burndown", query: q(`project = ${w.P1.key}`), config: { unit: "count" } })).data as { sprint: { id: string } | null };
    expect(b.sprint?.id).toBe(w.sprintP1Active);
    const s = ok(await run({ type: "sprint-status", query: q(`project = ${w.P1.key}`), config: {} })).data as { sprint: { id: string }; current: number; daysRemaining: number };
    expect(s.sprint.id).toBe(w.sprintP1Active);
    expect(s.current).toBe(1);
    // Mon 12 Oct → Wed 14 Oct.
    expect(s.daysRemaining).toBe(2);
  });

  it("a sprint filter picks that sprint, even a closed one", async () => {
    const defs: DashboardFilterDef[] = [{ key: "sprint", multi: true, default: null }];
    const b = ok(await run({ type: "burndown", query: q(`project = ${w.P1.key}`), config: {} }, { filters: defs, filterValues: { sprint: ["Sprint 0"] } })).data as { sprint: { id: string } | null };
    expect(b.sprint?.id).toBe(w.sprintP1Done);
  });

  it("cfd reconstructs from recorded status changes", async () => {
    const a = await prisma.activity.create({
      data: { orgId: w.orgA, workItemId: w.items["p1-login-bug"].id, userId: w.actor.id, action: "updated", field: "columnKey", oldValue: "todo", newValue: "in-progress", createdAt: new Date("2026-10-08T10:00:00Z") },
    });
    try {
      // NOW is before the items were created in this run; look at "today" instead.
      const [r] = await computePanels(w.ctx({ denyP3: true }), [{ type: "cfd", query: q(`project = ${w.P1.key}`), config: { window: "-7d" } }], { tz: "UTC", now: new Date() });
      const data = ok(r).data as { points: { counts: Record<string, number> }[]; exact: boolean };
      expect(data.points).toHaveLength(8);
      expect(data.exact).toBe(true);
      const last = data.points.at(-1)!.counts;
      expect((last.IN_PROGRESS ?? 0) + (last.TODO ?? 0) + (last.DONE ?? 0) + (last.CANCELLED ?? 0)).toBe(5);
    } finally {
      await prisma.activity.delete({ where: { id: a.id } });
    }
  });

  it("throughput, cycle-time and work-type-mix run on the viewer's items", async () => {
    for (const type of ["throughput", "cycle-time", "work-type-mix"]) {
      const r = await run({ type, query: q(`project = ${w.P1.key}`), config: type === "throughput" ? {} : { window: "-30d" } });
      noSecrets(r);
      expect("error" in r, type).toBe(false);
    }
  });
});

describe("the dashboard around the panels", () => {
  it("a filter narrows every panel unless it ignores it; unset adds nothing", async () => {
    const defs: DashboardFilterDef[] = [{ key: "person", multi: true, default: null }];
    const spec = (ignore: string[]): PanelSpec => ({ type: "number", query: q(`project = ${w.P1.key} AND statusCategory != DONE`), config: {}, ignoreFilters: ignore });
    const results = await computePanels(w.ctx({ denyP3: true }), [spec([]), spec(["person"])], { tz: "UTC", now: NOW, filters: defs, filterValues: { person: "@me" } });
    expect(ok(results[0]).data.value).toBe(1);
    expect(ok(results[1]).data.value).toBeGreaterThan(1);
    const unset = await computePanels(w.ctx({ denyP3: true }), [spec([])], { tz: "UTC", now: NOW, filters: defs, filterValues: { person: null } });
    expect(ok(unset[0]).data.value).toBe(ok(results[1]).data.value);
  });

  it("one bad panel never fails the batch", async () => {
    const results = await computePanels(
      w.ctx({ denyP3: true }),
      [
        { type: "number", query: q("priority = CRITICAL"), config: {} },
        { type: "no-such-panel", query: null, config: {} },
        { type: "item-list", query: null, config: { limit: 5000 } },
        { type: "item-list", query: { v: 1, where: { op: "cmp", field: { kind: "sys", id: "priority" }, cmp: "eq", value: { t: "str", v: "SUPERURGENT" } } }, config: {} },
      ],
      { tz: "UTC", now: NOW },
    );
    expect(ok(results[0]).data.value).toBe(1);
    expect(results.slice(1).map((r) => ("error" in r ? r.error.code : "ok"))).toEqual(["PANEL_UNSUPPORTED", "PANEL_INVALID_CONFIG", expect.stringMatching(/^CQL_/)]);
  });

  it("a panel that crashes answers a generic error; the others still answer", async () => {
    const real = COMPUTES.markdown;
    (COMPUTES as Record<string, unknown>).markdown = async () => {
      throw new Error("database exploded: secret detail");
    };
    try {
      const results = await computePanels(
        w.ctx({ denyP3: true }),
        [{ type: "markdown", query: null, config: {} }, { type: "number", query: q("priority = CRITICAL"), config: {} }],
        { tz: "UTC", now: NOW },
      );
      expect(results[0]).toEqual({ error: { code: "PANEL_FAILED", message: "This panel couldn't load. Try again." } });
      expect(ok(results[1]).data.value).toBe(1);
    } finally {
      (COMPUTES as Record<string, unknown>).markdown = real;
    }
  });

  it("text panels: a marked note raises the panel's level", async () => {
    const { meta } = ok(await run({ type: "markdown", query: null, config: { content: "Agenda — CUI//SP-PRVCY roster review" } }));
    expect(meta.classification?.level).toBe("CUI");
  });

  it("COMMERCIAL tenants get no classification fields at all", async () => {
    await prisma.organization.update({ where: { id: w.orgA }, data: { tenantClass: "COMMERCIAL" } });
    try {
      const r = ok(await run({ type: "item-list", query: q("priority = CRITICAL"), config: {} }));
      expect(r.meta.classification).toBeUndefined();
      expect(JSON.stringify(r.data)).not.toContain("classification");
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { tenantClass: "GOV" } });
    }
  });
});
