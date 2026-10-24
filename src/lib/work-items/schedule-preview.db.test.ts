// @vitest-environment node
//
// The Gantt's confirm step (POST …/work-items/schedule-preview), against a real
// database. It must describe exactly what the save would do (the cascade
// included), say who ends up with more on at once, ask enabled plugins for
// their rows within a time budget, check the caller as the save would, and
// write nothing.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";
import { updateWorkItems } from "@/lib/work-items/write.server";
import { PluginServerRegistry, type PluginServerHooks, type ScheduleImpactContext } from "@/lib/plugins/registry";

const h = vi.hoisted(() => ({ ctx: null as unknown, enabled: new Set<string>() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/plugins/enablement", () => ({ isPluginEnabled: async (_o: string, slug: string) => h.enabled.has(slug) }));

import { POST } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/schedule-preview/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", otherProject = "", owner = "", dev = "";
let parent = "", a = "", b = "", c = "", foreign = "", d = "", e = "";

const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const META = { actorId: null, source: "SYSTEM" as const };

const person = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: owner,
  orgId,
  orgRole: "OWNER",
  permissions: Permission.ITEM_READ | Permission.ITEM_UPDATE,
  basePermissions: Permission.ITEM_READ | Permission.ITEM_UPDATE,
  abacRules: [],
  ...over,
} as AuthContext);

async function item(title: string, start: string, due: string, extra: { parentId?: string; assigneeId?: string; storyPoints?: number; project?: string } = {}) {
  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const id = (await createFixtureWorkItem({ orgId, projectId: extra.project ?? projectId, workItemTypeId: typeId, createdById: owner, title, columnKey: "todo" })).id;
  await updateWorkItems(prisma, [id], {
    startDate: day(start),
    dueDate: day(due),
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
    ...(extra.assigneeId ? { assigneeId: extra.assigneeId } : {}),
    ...(extra.storyPoints ? { storyPoints: extra.storyPoints } : {}),
  }, META);
  return id;
}

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@preview.test`, displayName: "Owner" } })).id;
  dev = (await prisma.user.create({ data: { email: `dev-${stamp}@preview.test`, displayName: "Dana Dev" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `pv ${stamp}`, slug: `pv-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: dev, role: "MEMBER", permissions: "0" } });
  await prisma.orgMemberProfile.create({ data: { orgId, userId: dev, rateLevelKey: "SA", weeklyCapacity: 32 } });
  projectId = (await prisma.project.create({ data: { orgId, name: "P", key: `PV${stamp.slice(0, 3).toUpperCase()}` } })).id;
  otherProject = (await prisma.project.create({ data: { orgId, name: "Q", key: `PQ${stamp.slice(0, 3).toUpperCase()}` } })).id;
  // A plan: P contains A then B (A blocks B). Dana does A and C; C runs 7–8 Nov.
  parent = await item("Plan", "2026-11-01", "2026-11-20");
  a = await item("Design", "2026-11-02", "2026-11-06", { parentId: parent, assigneeId: dev, storyPoints: 3 });
  b = await item("Build", "2026-11-09", "2026-11-13", { parentId: parent });
  c = await item("Review", "2026-11-07", "2026-11-08", { assigneeId: dev, storyPoints: 2 });
  foreign = await item("Elsewhere", "2026-11-07", "2026-11-08", { assigneeId: dev, project: otherProject });
  await prisma.workItemLink.create({ data: { orgId, type: "BLOCKS", sourceItemId: a, targetItemId: b } });
  // Nobody's: D blocks E, so moving D pushes E and loads no one.
  d = await item("Order parts", "2026-12-01", "2026-12-03");
  e = await item("Fit parts", "2026-12-04", "2026-12-06");
  await prisma.workItemLink.create({ data: { orgId, type: "BLOCKS", sourceItemId: d, targetItemId: e } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, dev] } } }).catch(() => undefined);
});

afterEach(() => {
  h.enabled.clear();
  // The registry has no unregister: overwrite each test's hooks with inert ones.
  for (const slug of ["fees", "slow", "broken", "off"]) PluginServerRegistry.register({ slug });
});

const post = (changes: unknown, pid = projectId) =>
  POST(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${pid}/work-items/schedule-preview`, {
      method: "POST",
      body: JSON.stringify({ changes }),
    }),
    { params: Promise.resolve({ orgId, projectId: pid }) },
  );
const slipA = [{ id: "", startDate: "2026-11-05T00:00:00.000Z", dueDate: "2026-11-09T00:00:00.000Z" }];
const withA = () => slipA.map((x) => ({ ...x, id: a }));

describe("schedule preview", () => {
  it("returns what the save would move, the cascade included, and writes nothing", async () => {
    h.ctx = person();
    const res = await post(withA());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes).toEqual([
      { itemId: a, before: { startDate: "2026-11-02T00:00:00.000Z", dueDate: "2026-11-06T00:00:00.000Z" }, after: { startDate: "2026-11-05T00:00:00.000Z", dueDate: "2026-11-09T00:00:00.000Z" } },
    ]);
    // A slipped 3 days, so B (blocked by A) shifts 3 days with it.
    expect(body.cascaded).toEqual([
      expect.objectContaining({ itemId: b, reason: "successor-shift", after: { startDate: "2026-11-12T00:00:00.000Z", dueDate: "2026-11-16T00:00:00.000Z" } }),
    ]);
    expect(body.needsConfirm).toBe(true);
    // A dry run: nothing in the database moved.
    const rows = await prisma.workItem.findMany({ where: { id: { in: [a, b, parent] } }, select: { id: true, startDate: true, dueDate: true } });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.dueDate?.toISOString()]))).toEqual({
      [a]: "2026-11-06T00:00:00.000Z",
      [b]: "2026-11-13T00:00:00.000Z",
      [parent]: "2026-11-20T00:00:00.000Z",
    });
  });

  it("names whoever ends up with more running at once, from this project only", async () => {
    h.ctx = person();
    const body = await (await post(withA())).json();
    // A now overlaps Dana's C (7–8 Nov): two at once. Her item in the other
    // project overlaps too, but another project is never counted.
    expect(body.allocation).toEqual([
      { userId: dev, name: "Dana Dev", weeklyCapacityHours: 32, peakBefore: 1, peakAfter: 2, pointsBefore: 5, pointsAfter: 5 },
    ]);
    expect(JSON.stringify(body)).not.toContain(foreign);
  });

  it("pushing a dependent alone is reason to confirm, even with nobody's load changing", async () => {
    h.ctx = person();
    const body = await (await post([{ id: d, startDate: "2026-12-02T00:00:00.000Z", dueDate: "2026-12-05T00:00:00.000Z" }])).json();
    expect(body.cascaded.map((x: { itemId: string }) => x.itemId)).toEqual([e]);
    expect(body.allocation).toEqual([]);
    expect(body.needsConfirm).toBe(true);
  });

  it("a move that pushes nothing and loads nobody needs no confirm", async () => {
    h.ctx = person();
    // C moves a day later: no successor, no parent, and Dana still has one
    // thing at a time (A ends on the 6th).
    const body = await (await post([{ id: c, startDate: "2026-11-08T00:00:00.000Z", dueDate: "2026-11-09T00:00:00.000Z" }])).json();
    expect(body.cascaded).toEqual([]);
    expect(body.needsConfirm).toBe(false);
  });

  it("is checked as the save is: ITEM_UPDATE, the item's own project, and no foreign ids", async () => {
    h.ctx = person({ orgRole: "MEMBER", permissions: Permission.ITEM_READ, basePermissions: Permission.ITEM_READ });
    expect((await post(withA())).status).toBe(403);
    h.ctx = person();
    // An item from another project, or one that doesn't exist, is a 404 like the PUT's.
    expect((await post([{ id: foreign, startDate: null, dueDate: null }])).status).toBe(404);
    expect((await post([{ id: "9f8e7d6c-5b4a-4321-8fed-cba987654321", startDate: null, dueDate: null }])).status).toBe(404);
  });

  it("an API key needs items:write, the scope the save itself needs", async () => {
    h.ctx = person({ isApiKey: true, scopes: ["read"], permissions: scopeMask(["read"]) });
    expect((await post(withA())).status).toBe(403);
    h.ctx = person({ isApiKey: true, scopes: ["items:write"], permissions: scopeMask(["items:write"]) });
    expect((await post(withA())).status).toBe(200);
  });
});

describe("schedule preview: plugin sections", () => {
  const register = (hooks: PluginServerHooks) => PluginServerRegistry.register(hooks);

  it("an enabled plugin's rows are added, slug-prefixed, and it is told the cascade and the caller", async () => {
    h.ctx = person();
    let seen: ScheduleImpactContext | null = null;
    register({
      slug: "fees",
      scheduleImpact: async (_db, ctx) => {
        seen = ctx;
        return [{ key: "fee", title: "Fee and rate", rows: [{ key: "rate", label: "Effective rate", before: "$100/h", after: "$90/h", tone: "warn" }] }];
      },
    });
    h.enabled.add("fees");
    const body = await (await post(withA())).json();
    expect(body.sections).toEqual([
      { key: "fees:fee", title: "Fee and rate", rows: [{ key: "rate", label: "Effective rate", before: "$100/h", after: "$90/h", tone: "warn" }] },
    ]);
    expect(seen!.projectId).toBe(projectId);
    expect(seen!.cascaded.map((x) => x.itemId)).toEqual([b]);
    expect(seen!.auth.userId).toBe(owner);
  });

  it("a disabled plugin is never asked", async () => {
    h.ctx = person();
    const hook = vi.fn(async () => [{ key: "x", title: "X", rows: [] }]);
    register({ slug: "off", scheduleImpact: hook });
    const body = await (await post(withA())).json();
    expect(hook).not.toHaveBeenCalled();
    expect(body.sections).toEqual([]);
  });

  it("a slow, throwing or malformed plugin loses its section and never fails the preview", async () => {
    h.ctx = person();
    register({ slug: "slow", scheduleImpact: () => new Promise((r) => setTimeout(() => r([{ key: "late", title: "Late", rows: [] }]), 5000)) });
    register({ slug: "broken", scheduleImpact: async () => { throw new Error("secret detail"); } });
    register({ slug: "fees", scheduleImpact: async () => [{ key: "bad", title: "", rows: "nope" }] as never });
    for (const s of ["slow", "broken", "fees"]) h.enabled.add(s);
    const started = Date.now();
    const res = await post(withA());
    expect(res.status).toBe(200);
    expect((await res.json()).sections).toEqual([]);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("a plugin can't point the dialog off-site", async () => {
    h.ctx = person();
    register({
      slug: "fees",
      scheduleImpact: async () => [{ key: "p", title: "Hours", rows: [], prompt: { message: "Add hours", action: { label: "Plan", href: "https://evil.example/x" } } }],
    });
    h.enabled.add("fees");
    expect((await (await post(withA())).json()).sections).toEqual([]);
  });
});
