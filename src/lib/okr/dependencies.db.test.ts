// @vitest-environment node
//
// Objective dependencies, through the real routes against a real database:
// one objective can need another done first, across projects but never across
// orgs; never itself; never in a loop; and only an objective the writer can
// see and read OKRs on. The board lists only dependencies the reader could
// open, flags an objective whose due day has passed, and saves a due date set
// when the objective is created.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as listObjectives, POST as createObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/route";
import { POST as addDependency } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/dependencies/route";
import { DELETE as removeDependency } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/dependencies/[dependsOnId]/route";
import { DEPENDENCY_LOOP, SELF_DEPENDENCY } from "./dependencies.server";

const stamp = Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;
const org = { a: "", b: "" };
const u = { editor: "", insider: "" };
const p = { one: "", two: "", sec: "", other: "" };
const o: Record<string, string> = {};

function session(who: keyof typeof u, extra: Partial<AuthContext> = {}): AuthContext {
  const permissions = RolePermissions.MEMBER;
  return { userId: u[who], orgId: org.a, orgRole: "MEMBER", abacRules: [], basePermissions: permissions, permissions, ...extra };
}

const url = (path: string) => `http://localhost/api/v1/orgs/${org.a}${path}`;

async function depend(ctx: AuthContext, projectId: string, objectiveId: string, dependsOnId: string) {
  h.ctx = ctx;
  const res = await addDependency(
    new NextRequest(url(`/projects/${projectId}/objectives/${objectiveId}/dependencies`), {
      method: "POST",
      body: JSON.stringify({ dependsOnId }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ orgId: org.a, projectId, objectiveId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function undepend(ctx: AuthContext, projectId: string, objectiveId: string, dependsOnId: string) {
  h.ctx = ctx;
  const res = await removeDependency(
    new NextRequest(url(`/projects/${projectId}/objectives/${objectiveId}/dependencies/${dependsOnId}`), { method: "DELETE" }),
    { params: Promise.resolve({ orgId: org.a, projectId, objectiveId, dependsOnId }) },
  );
  return res.status;
}

type Listed = { id: string; overdue: boolean; health: string; targetDate: string | null; dependsOn: Array<{ id: string; overdue: boolean; health: string }> };
async function board(ctx: AuthContext, projectId: string): Promise<Listed[]> {
  h.ctx = ctx;
  const res = await listObjectives(new NextRequest(url(`/projects/${projectId}/objectives`)), {
    params: Promise.resolve({ orgId: org.a, projectId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed[];
}
const listed = async (ctx: AuthContext, projectId: string, id: string) => (await board(ctx, projectId)).find((x) => x.id === id)!;
const edgeCount = (objectiveId: string) => prisma.objectiveDependency.count({ where: { objectiveId } });

beforeAll(async () => {
  org.a = (await prisma.organization.create({ data: { name: `dep a ${stamp}`, slug: `dep-a-${stamp}` } })).id;
  org.b = (await prisma.organization.create({ data: { name: `dep b ${stamp}`, slug: `dep-b-${stamp}` } })).id;
  const om: Record<string, string> = {};
  for (const k of Object.keys(u) as (keyof typeof u)[]) {
    u[k] = (await prisma.user.create({ data: { email: `${k}-${stamp}@dep.test`, displayName: `${k} ${stamp}` } })).id;
    om[k] = (await prisma.orgMember.create({ data: { orgId: org.a, userId: u[k], role: "MEMBER", permissions: "0" } })).id;
  }
  const project = (orgId: string, name: string, teamScopedAccess = false) =>
    prisma.project.create({ data: { orgId, name: `${name} ${stamp}`, key: `${name[0]}${stamp}`.toUpperCase().slice(0, 7), teamScopedAccess } });
  p.one = (await project(org.a, "One")).id;
  p.two = (await project(org.a, "Two")).id;
  p.sec = (await project(org.a, "Sec", true)).id;
  p.other = (await project(org.b, "Other")).id;
  await prisma.projectMember.create({ data: { projectId: p.sec, orgMemberId: om.insider } });

  const objective = async (orgId: string, projectId: string, title: string, extra: Record<string, unknown> = {}) =>
    (await prisma.objective.create({ data: { orgId, projectId, title: `${title} ${stamp}`, ...extra } })).id;
  for (const k of ["a", "b", "c", "x", "y", "lone"]) o[k] = await objective(org.a, p.one, k);
  o.across = await objective(org.a, p.two, "across");
  o.secret = await objective(org.a, p.sec, "secret");
  // For the gate tests below, so earlier tests' edges can't interfere.
  for (const k of ["waits", "w1", "w2", "w3"]) o[k] = await objective(org.a, p.one, k);
  o.secretWaits = await objective(org.a, p.sec, "secret waits");
  o.foreign = await objective(org.b, p.other, "foreign");
  // Due days, relative to now: one ended yesterday, one is today, one is done.
  const today = Math.floor(Date.now() / DAY) * DAY;
  o.late = await objective(org.a, p.one, "late", { targetDate: new Date(today - DAY) });
  o.dueToday = await objective(org.a, p.one, "due today", { targetDate: new Date(today) });
  o.lateDone = await objective(org.a, p.one, "late done", { targetDate: new Date(today - DAY), status: "COMPLETED" });
});

afterAll(async () => {
  for (const id of [org.a, org.b]) {
    await prisma.objectiveDependency.deleteMany({ where: { orgId: id } });
    await prisma.objective.deleteMany({ where: { orgId: id } });
    await prisma.projectMember.deleteMany({ where: { project: { orgId: id } } });
    await prisma.project.deleteMany({ where: { orgId: id } });
    await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: id } });
  }
  await prisma.organization.deleteMany({ where: { id: { in: [org.a, org.b] } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } });
});

describe("adding a dependency", () => {
  it("links an objective to one in another project of the same org, and the board shows it (positive control)", async () => {
    const res = await depend(session("editor"), p.one, o.a, o.across);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ objectiveId: o.a, dependsOnId: o.across, orgId: org.a });
    const a = await listed(session("editor"), p.one, o.a);
    expect(a.dependsOn.map((d) => d.id)).toEqual([o.across]);
    // Adding it again changes nothing.
    expect((await depend(session("editor"), p.one, o.a, o.across)).status).toBe(200);
    expect(await edgeCount(o.a)).toBe(1);
  });

  it("refuses another org's objective, and writes nothing", async () => {
    const res = await depend(session("editor"), p.one, o.lone, o.foreign);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("That objective doesn't exist in this organization.");
    expect(await edgeCount(o.lone)).toBe(0);
  });

  it("refuses a team-scoped project's objective to someone off the team, and allows it for someone on it", async () => {
    const off = await depend(session("editor"), p.one, o.lone, o.secret);
    expect(off.status).toBe(400);
    expect(off.body.detail).toBe("That objective doesn't exist in this organization.");
    expect(await edgeCount(o.lone)).toBe(0);
    // Control: the same edge from someone on the team.
    expect((await depend(session("insider"), p.one, o.lone, o.secret)).status).toBe(200);
    expect(await edgeCount(o.lone)).toBe(1);
    expect(await undepend(session("insider"), p.one, o.lone, o.secret)).toBe(200);
  });

  it("holds an API key to its project scope", async () => {
    const keyed = session("editor", { isApiKey: true, scopes: ["read", "items:write"], projectScope: [p.one] });
    expect((await depend(keyed, p.one, o.lone, o.across)).status).toBe(400);
    // Control: a project inside its scope.
    expect((await depend(keyed, p.one, o.lone, o.b)).status).toBe(200);
    expect(await undepend(keyed, p.one, o.lone, o.b)).toBe(200);
  });

  it("refuses an objective whose project the writer can't read OKRs in", async () => {
    const noOkrRead = RolePermissions.MEMBER & ~Permission.OKR_READ;
    const res = await depend(session("editor", { permissions: noOkrRead, basePermissions: noOkrRead }), p.one, o.lone, o.across);
    expect(res.status).toBe(400);
    expect(await edgeCount(o.lone)).toBe(0);
  });

  it("refuses an objective depending on itself, and so does the database", async () => {
    const res = await depend(session("editor"), p.one, o.lone, o.lone);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe(SELF_DEPENDENCY);
    await expect(
      prisma.objectiveDependency.create({ data: { orgId: org.a, objectiveId: o.lone, dependsOnId: o.lone } }),
    ).rejects.toThrow();
  });

  it("refuses a loop, direct or several steps long", async () => {
    expect((await depend(session("editor"), p.one, o.b, o.c)).status).toBe(200);
    expect((await depend(session("editor"), p.one, o.c, o.x)).status).toBe(200);
    const direct = await depend(session("editor"), p.one, o.c, o.b);
    expect(direct.status).toBe(400);
    expect(direct.body.detail).toBe(DEPENDENCY_LOOP);
    const long = await depend(session("editor"), p.one, o.x, o.b);
    expect(long.status).toBe(400);
    expect(await edgeCount(o.x)).toBe(0);
    // Control: the same objectives in a direction that closes no loop.
    expect((await depend(session("editor"), p.one, o.b, o.x)).status).toBe(200);
  });

  it("waits for a dependency being written at the same moment, so the two can't close a loop between them", async () => {
    // A writer holding the org's dependency lock, mid-way through adding
    // y -> lateDone and not yet committed. The opposite edge, requested now,
    // must wait for it and then see it; read before that commit, it would
    // find no edge and write the second half of a loop.
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const writer = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20210::int, hashtext(${org.a}))`;
      await tx.objectiveDependency.create({ data: { orgId: org.a, objectiveId: o.y, dependsOnId: o.lateDone } });
      locked();
      await new Promise((r) => setTimeout(r, 750));
    }, { timeout: 15_000 });
    await holding;
    const opposite = await depend(session("editor"), p.one, o.lateDone, o.y);
    await writer;
    expect(opposite.status).toBe(400);
    expect(opposite.body.detail).toBe(DEPENDENCY_LOOP);
    expect(await edgeCount(o.lateDone)).toBe(0);
  });

  it("is refused to a role that can't edit objectives", async () => {
    const viewer = session("editor", { orgRole: "VIEWER", permissions: RolePermissions.VIEWER, basePermissions: RolePermissions.VIEWER });
    expect((await depend(viewer, p.one, o.lone, o.c)).status).toBe(403);
    expect(await edgeCount(o.lone)).toBe(0);
  });
});

describe("the objective that waits", () => {
  it("is refused to someone who can't see its project, when adding (positive control on the team)", async () => {
    const off = await depend(session("editor"), p.sec, o.secretWaits, o.w3);
    expect(off.status).toBe(403);
    expect(await edgeCount(o.secretWaits)).toBe(0);
    // Control: the same edge from someone on the team.
    expect((await depend(session("insider"), p.sec, o.secretWaits, o.w3)).status).toBe(200);
    expect(await edgeCount(o.secretWaits)).toBe(1);
  });

  it("is refused to someone who can't see its project, when removing, and the edge stays", async () => {
    // Left by the test above: secretWaits -> w3, both ends readable to the insider.
    expect(await undepend(session("editor"), p.sec, o.secretWaits, o.w3)).toBe(403);
    expect(await edgeCount(o.secretWaits)).toBe(1);
    // Control: on the team, it goes.
    expect(await undepend(session("insider"), p.sec, o.secretWaits, o.w3)).toBe(200);
    expect(await edgeCount(o.secretWaits)).toBe(0);
  });
});

describe("removing a dependency on an objective the caller can't open", () => {
  it("answers 404, as for one that doesn't exist, and leaves the edge in place", async () => {
    expect((await depend(session("insider"), p.one, o.waits, o.secret)).status).toBe(200);
    // Off the team: the same 404 as an edge that was never there.
    expect(await undepend(session("editor"), p.one, o.waits, o.c)).toBe(404);
    expect(await undepend(session("editor"), p.one, o.waits, o.secret)).toBe(404);
    expect(await edgeCount(o.waits)).toBe(1);
    // Control: on the team, it goes.
    expect(await undepend(session("insider"), p.one, o.waits, o.secret)).toBe(200);
    expect(await edgeCount(o.waits)).toBe(0);
  });

  it("answers 404 where a rule denies reading OKRs in the other objective's project", async () => {
    expect((await depend(session("editor"), p.one, o.waits, o.across)).status).toBe(200);
    const deny = { effect: "deny" as const, actions: ["OKR_READ"], conditions: [{ attr: "projectId", op: "eq" as const, value: p.two }] };
    const denied = session("editor", { abacRules: [deny] as AuthContext["abacRules"] });
    expect(await undepend(denied, p.one, o.waits, o.across)).toBe(404);
    expect(await edgeCount(o.waits)).toBe(1);
    // Control: without the rule, it goes.
    expect(await undepend(session("editor"), p.one, o.waits, o.across)).toBe(200);
  });
});

describe("a loop through objectives the caller can't see", () => {
  it("is refused without saying which objective closes it", async () => {
    // On the team: w1 -> secret -> w2. Off the team, neither edge is listed.
    expect((await depend(session("insider"), p.one, o.w1, o.secret)).status).toBe(200);
    expect((await depend(session("insider"), p.sec, o.secret, o.w2)).status).toBe(200);
    expect((await listed(session("editor"), p.one, o.w1)).dependsOn).toEqual([]);
    expect((await listed(session("editor"), p.one, o.w2)).dependsOn).toEqual([]);
    // w2 -> w1 still closes the loop, and is refused in words that claim no
    // direct dependency the caller could check.
    const res = await depend(session("editor"), p.one, o.w2, o.w1);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("This would create a loop of dependencies.");
    expect(await edgeCount(o.w2)).toBe(0);
    // Control: an edge that closes no loop is allowed.
    expect((await depend(session("editor"), p.one, o.w2, o.c)).status).toBe(200);
  });
});

describe("reading dependencies", () => {
  it("lists a dependency on a team-scoped project's objective only for people on the team", async () => {
    expect((await depend(session("insider"), p.one, o.dueToday, o.secret)).status).toBe(200);
    expect((await listed(session("insider"), p.one, o.dueToday)).dependsOn.map((d) => d.id)).toEqual([o.secret]);
    expect((await listed(session("editor"), p.one, o.dueToday)).dependsOn).toEqual([]);
  });

  it("removes a dependency, and a second removal finds nothing", async () => {
    expect(await undepend(session("insider"), p.one, o.dueToday, o.secret)).toBe(200);
    expect(await undepend(session("insider"), p.one, o.dueToday, o.secret)).toBe(404);
    expect(await edgeCount(o.dueToday)).toBe(0);
  });

  it("goes when either objective is deleted", async () => {
    const gone = (await prisma.objective.create({ data: { orgId: org.a, projectId: p.one, title: `gone ${stamp}` } })).id;
    expect((await depend(session("editor"), p.one, gone, o.c)).status).toBe(200);
    await prisma.objective.delete({ where: { id: gone } });
    expect(await prisma.objectiveDependency.count({ where: { dependsOnId: o.c, objectiveId: gone } })).toBe(0);
  });
});

describe("due dates", () => {
  it("flags an objective whose due day has ended, and not one due today or already done", async () => {
    const rows = await board(session("editor"), p.one);
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(o.late)).toMatchObject({ overdue: true, health: "behind" });
    expect(by(o.dueToday).overdue).toBe(false);
    expect(by(o.lateDone)).toMatchObject({ overdue: false, health: "done" });
  });

  it("shows an overdue dependency as overdue on the objective that waits for it", async () => {
    expect((await depend(session("editor"), p.one, o.lone, o.late)).status).toBe(200);
    expect((await listed(session("editor"), p.one, o.lone)).dependsOn).toMatchObject([{ id: o.late, overdue: true }]);
  });

  it("saves a due date given when the objective is created", async () => {
    h.ctx = session("editor");
    const res = await createObjective(
      new NextRequest(url(`/projects/${p.one}/objectives`), {
        method: "POST",
        body: JSON.stringify({ title: `dated ${stamp}`, targetDate: "2026-12-31T00:00:00.000Z" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ orgId: org.a, projectId: p.one }) },
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await prisma.objective.findUniqueOrThrow({ where: { id } })).targetDate?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });
});
