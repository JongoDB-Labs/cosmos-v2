// @vitest-environment node
//
// A person removed from an org keeps their rows: the org_members row is
// soft-deleted, and the project, team and work-role rows that hang off it are
// retained so a reinstatement brings them back. src/lib/db/client.ts hides the
// org_members row from direct `orgMember` reads, but nothing else: a relation
// read (`include: { members }`, a nested select, `_count`) never reaches that
// hook, and neither does a direct read of `projectMember`, `teamMember` or
// `orgMemberWorkRole`. So the removed person kept appearing in project
// rosters, team rosters and member counts, to people and to Cosmo.
//
// Against a real database, through the real routes and tools. Only
// `getAuthContext` is stood in for, handing each route the owner's real
// AuthContext. The person is removed through the real DELETE route. Own org and
// users; the seeded users are shared. Every "the removed person is absent"
// assertion has a current member beside it who must be present, and the
// retained rows are checked to exist, so an absence means a filter, not an
// empty fixture.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  revalidateTag: () => undefined,
  updateTag: () => undefined,
}));

import { prisma } from "@/lib/db/client";
import { maskToDb } from "@/lib/rbac/permissions";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";
import type { ToolContext } from "@/lib/ai/executors/_ctx";
import { DELETE as removeMemberRoute } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/route";
import { POST as addMemberRoute } from "@/app/api/v1/orgs/[orgId]/members/route";
import { GET as projectMembersRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/members/route";
import { GET as projectRoute, PUT as putProjectRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/route";
import { GET as projectsRoute } from "@/app/api/v1/orgs/[orgId]/projects/route";
import { GET as teamsRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/teams/route";
import { POST as addTeamMemberRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/teams/[teamId]/route";
import { PATCH as patchStaffingRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/staffing/[memberId]/route";
import { GET as planningRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/planning/route";
import { GET as ceremonyRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/route";
import { GET as workRolesRoute } from "@/app/api/v1/orgs/[orgId]/work-roles/route";
import { GET as workRoleRoute } from "@/app/api/v1/orgs/[orgId]/work-roles/[roleId]/route";
import { GET as rosterRoute, PUT as putRosterRoute } from "@/app/api/v1/orgs/[orgId]/work-roles/[roleId]/members/route";
import { addTeamMemberTool, listProjectMembers } from "@/lib/ai/executors/people";
import { listTeams, teamFilter } from "@/lib/ai/executors/teams";
import { loadTeamRosters } from "@/lib/teams/item-team.server";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userIds: string[] = [];
let orgId = "";
let projectId = "";
let teamId = "";
let intervalId = "";
let workRoleId = "";
let owner: ToolContext;
/** Still a member. On the project, the team and the work role. */
const current = { userId: "", memberId: "", projectMemberId: "", itemId: "" };
/** Removed from the org through the real route, after joining all the same things. */
const removed = { userId: "", memberId: "", projectMemberId: "", itemId: "" };
/** A current member on the project but on no team yet: the positive control for team adds. */
const newcomer = { userId: "", memberId: "", projectMemberId: "" };

async function user(name: string) {
  const u = await prisma.user.create({ data: { email: `${name}-${stamp}@removed-reads.test`, displayName: `${name} ${stamp}` } });
  userIds.push(u.id);
  return u.id;
}

/** Call a route as the owner; returns the status and the parsed body. */
async function asOwner(
  handler: (r: NextRequest, c: never) => Promise<Response>,
  params: Record<string, string>,
  method = "GET",
  body?: unknown,
  search = "",
) {
  getAuthContext.mockResolvedValue(owner.auth);
  const res = await handler(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/x${search}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    { params: Promise.resolve({ orgId, ...params }) } as never,
  );
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text; // a plain-text refusal, e.g. "Not found"
  }
  return { status: res.status, body: parsed };
}

type Row = Record<string, unknown>;
const userIdsOf = (rows: Row[]) => rows.map((r) => r.userId);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `removed reads ${stamp}`, slug: `rmr-${stamp}` } })).id;
  const ownerId = await user("owner");
  const ownerMemberId = (await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER" } })).id;
  for (const [who, name] of [[current, "current"], [removed, "removed"], [newcomer, "newcomer"]] as const) {
    who.userId = await user(name);
    who.memberId = (await prisma.orgMember.create({ data: { orgId, userId: who.userId, role: "MEMBER" } })).id;
  }

  const k = stamp.slice(-4).toUpperCase();
  projectId = (await prisma.project.create({ data: { orgId, name: "Roster", key: `RMR${k}` } })).id;
  await prisma.projectMember.create({ data: { projectId, orgMemberId: ownerMemberId, role: "MANAGER" } });
  for (const who of [current, removed, newcomer]) {
    who.projectMemberId = (await prisma.projectMember.create({ data: { projectId, orgMemberId: who.memberId, role: "MEMBER" } })).id;
  }
  teamId = (await prisma.team.create({ data: { orgId, projectId, name: "Platform" } })).id;
  for (const who of [current, removed]) {
    await prisma.teamMember.create({ data: { teamId, projectMemberId: who.projectMemberId } });
  }

  workRoleId = (await prisma.workRole.create({ data: { orgId, key: `rmr-${stamp}`, name: "Reviewer", grants: maskToDb(0n) } })).id;
  for (const who of [current, removed]) {
    await prisma.orgMemberWorkRole.create({ data: { orgMemberId: who.memberId, workRoleId } });
  }

  // A sprint with one item each, named to no team, and each person's capacity.
  intervalId = (await prisma.interval.create({
    data: { orgId, projectId, number: 1, name: "Sprint 1", startDate: new Date(), endDate: new Date(Date.now() + 14 * 86_400_000) },
  })).id;
  const typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  for (const [who, points] of [[current, 3], [removed, 5]] as const) {
    const item = await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: ownerId, title: `${who.userId} work`, columnKey: "todo" });
    await prisma.workItem.update({ where: { id: item.id }, data: { assigneeId: who.userId, intervalId, storyPoints: points } });
    who.itemId = item.id;
    await prisma.intervalCapacity.create({ data: { intervalId, userId: who.userId, capacity: points } });
  }

  owner = await memberToolCtx(orgId, ownerId);
  const gone = await asOwner(removeMemberRoute, { memberId: removed.memberId }, "DELETE");
  expect(gone.status).toBe(204);
}, 120_000);

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("the fixture", () => {
  it("removed the person and kept every row that hangs off their membership", async () => {
    // Without these the absences below would prove nothing.
    expect(await prisma.orgMember.findFirst({ where: { id: removed.memberId } })).toBeNull();
    expect(await prisma.projectMember.count({ where: { id: removed.projectMemberId } })).toBe(1);
    expect(await prisma.teamMember.count({ where: { teamId, projectMemberId: removed.projectMemberId } })).toBe(1);
    expect(await prisma.orgMemberWorkRole.count({ where: { orgMemberId: removed.memberId, workRoleId } })).toBe(1);
  });
});

describe("lists", () => {
  it("the project roster lists current members only", async () => {
    const r = await asOwner(projectMembersRoute, { projectId });
    expect(r.status).toBe(200);
    expect(userIdsOf(r.body)).toContain(current.userId);
    expect(userIdsOf(r.body)).not.toContain(removed.userId);
  });

  it("the project's own members (a nested include) are current members only", async () => {
    const r = await asOwner(projectRoute, { projectId });
    expect(r.status).toBe(200);
    const ids = (r.body.members as { orgMember: { user: { id: string } } }[]).map((m) => m.orgMember.user.id);
    expect(ids).toContain(current.userId);
    expect(ids).not.toContain(removed.userId);
  });

  it("the work role's roster lists current holders only", async () => {
    const r = await asOwner(rosterRoute, { roleId: workRoleId });
    expect(r.status).toBe(200);
    expect(r.body.orgMemberIds).toContain(current.memberId);
    expect(r.body.orgMemberIds).not.toContain(removed.memberId);
  });
});

describe("counts", () => {
  // Owner, current and newcomer: three current members. The removed one made four.
  it("the project's member count counts current members", async () => {
    const r = await asOwner(projectRoute, { projectId });
    expect(r.body._count.members).toBe(3);
  });

  it("the project list's member count counts current members", async () => {
    const r = await asOwner(projectsRoute, {});
    expect(r.status).toBe(200);
    const row = (r.body as { id: string; _count: { members: number } }[]).find((p) => p.id === projectId);
    expect(row?._count.members).toBe(3);
  });

  it("the count a project edit answers with counts current members", async () => {
    const r = await asOwner(putProjectRoute, { projectId }, "PUT", { description: "edited" });
    expect(r.status).toBe(200);
    expect(r.body._count.members).toBe(3);
  });

  it("a work role's member count counts current holders, in the list and on its own", async () => {
    const list = await asOwner(workRolesRoute, {});
    expect((list.body as { id: string; memberCount: number }[]).find((w) => w.id === workRoleId)?.memberCount).toBe(1);
    const one = await asOwner(workRoleRoute, { roleId: workRoleId });
    expect(one.body.memberCount).toBe(1);
  });
});

describe("nested selects", () => {
  it("a team's roster lists current members only", async () => {
    const r = await asOwner(teamsRoute, { projectId });
    expect(r.status).toBe(200);
    const team = (r.body as { id: string; members: Row[] }[]).find((t) => t.id === teamId)!;
    expect(userIdsOf(team.members)).toContain(current.userId);
    expect(userIdsOf(team.members)).not.toContain(removed.userId);
  });

  it("the query language's team rosters hold current members only", async () => {
    const rosters = await loadTeamRosters(prisma, orgId, [projectId]);
    expect(rosters.get(teamId)?.userIds).toContain(current.userId);
    expect(rosters.get(teamId)?.userIds).not.toContain(removed.userId);
  });

  it("sprint planning scoped to a team counts current members' work and capacity only", async () => {
    const r = await asOwner(planningRoute, { projectId, intervalId }, "GET", undefined, `?teamId=${teamId}`);
    expect(r.status).toBe(200);
    expect(r.body.committed.itemCount).toBe(1);
    expect(Object.keys(r.body.current)).toEqual([current.userId]);
    // Unscoped, both items are in the sprint: the narrowing above is the team's.
    const all = await asOwner(planningRoute, { projectId, intervalId });
    expect(all.body.committed.itemCount).toBe(2);
  });

  it("a sprint review scoped to a team counts current members' work only", async () => {
    const boardId = (await prisma.board.create({ data: { orgId, projectId, name: "Review", type: "SPRINT_REVIEW" } })).id;
    const r = await asOwner(ceremonyRoute, { projectId, intervalId }, "GET", undefined, `?boardId=${boardId}&teamId=${teamId}`);
    expect(r.status).toBe(200);
    expect([r.body.metrics.totalItems, r.body.metrics.totalPoints]).toEqual([1, 3]);
    const all = await asOwner(ceremonyRoute, { projectId, intervalId }, "GET", undefined, `?boardId=${boardId}`);
    expect([all.body.metrics.totalItems, all.body.metrics.totalPoints]).toEqual([2, 8]);
  });
});

describe("writes that hang off a membership", () => {
  it("a removed person's project membership cannot be put on a team", async () => {
    const refused = await asOwner(addTeamMemberRoute, { projectId, teamId }, "POST", { projectMemberId: removed.projectMemberId });
    expect(refused.status).toBe(400);
    try {
      const control = await asOwner(addTeamMemberRoute, { projectId, teamId }, "POST", { projectMemberId: newcomer.projectMemberId });
      expect(control.status).toBe(201);
    } finally {
      await prisma.teamMember.deleteMany({ where: { teamId, projectMemberId: newcomer.projectMemberId } });
    }
  });

  it("a removed person's project role cannot be changed from the staffing register", async () => {
    const refused = await asOwner(patchStaffingRoute, { projectId, memberId: removed.projectMemberId }, "PATCH", { role: "MANAGER" });
    expect(refused.status).toBe(404);
    expect((await prisma.projectMember.findUnique({ where: { id: removed.projectMemberId } }))?.role).toBe("MEMBER");
    const control = await asOwner(patchStaffingRoute, { projectId, memberId: current.projectMemberId }, "PATCH", { allocationPercent: 50 });
    expect(control.status).toBe(200);
  });

  it("saving a work role's roster keeps a removed holder's role for their reinstatement", async () => {
    const saved = await asOwner(putRosterRoute, { roleId: workRoleId }, "PUT", { orgMemberIds: [current.memberId] });
    expect(saved.status).toBe(200);
    expect(await prisma.orgMemberWorkRole.count({ where: { orgMemberId: removed.memberId, workRoleId } })).toBe(1);
    // The saved roster itself still took effect for current members.
    expect(await prisma.orgMemberWorkRole.count({ where: { orgMemberId: current.memberId, workRoleId } })).toBe(1);
  });
});

describe("Cosmo", () => {
  it("list_project_members lists current members only", async () => {
    const r = (await listProjectMembers({ projectId }, owner)) as { members: Row[] };
    expect(userIdsOf(r.members)).toContain(current.userId);
    expect(userIdsOf(r.members)).not.toContain(removed.userId);
  });

  it("list_teams counts current members", async () => {
    const r = (await listTeams({ projectId }, owner)) as { teams: { id: string; memberCount: number }[] };
    expect(r.teams.find((t) => t.id === teamId)?.memberCount).toBe(1);
  });

  it("a team filter takes current members' work only", async () => {
    const f = await teamFilter(orgId, teamId, [projectId]);
    if ("error" in f) throw new Error(f.error);
    const ids = (await prisma.workItem.findMany({ where: { AND: [{ projectId }, f.where] }, select: { id: true } })).map((w) => w.id);
    expect(ids).toContain(current.itemId);
    expect(ids).not.toContain(removed.itemId);
  });

  it("add_team_member refuses a removed person", async () => {
    const refused = (await addTeamMemberTool({ projectId, teamId, userId: removed.userId }, owner)) as Row;
    // The tool's own lookup answers, before the membership service is reached:
    // the service refuses too, but without telling Cosmo what to do instead.
    expect(refused.error).toBe("That person is not a member of this project. Add them with add_project_member first.");
    expect(await prisma.teamMember.count({ where: { teamId, projectMemberId: removed.projectMemberId } })).toBe(1);
    try {
      const control = (await addTeamMemberTool({ projectId, teamId, userId: newcomer.userId }, owner)) as Row;
      expect(control.added).toBe(true);
    } finally {
      await prisma.teamMember.deleteMany({ where: { teamId, projectMemberId: newcomer.projectMemberId } });
    }
  });
});

describe("reinstatement", () => {
  // Last: it brings the removed person back.
  it("brings back the person's retained rows, work role included", async () => {
    const back = await asOwner(addMemberRoute, {}, "POST", { userId: removed.userId, role: "MEMBER" });
    expect(back.status).toBe(201);
    const roster = await asOwner(rosterRoute, { roleId: workRoleId });
    expect(roster.body.orgMemberIds).toContain(removed.memberId);
    const members = await asOwner(projectMembersRoute, { projectId });
    expect(userIdsOf(members.body)).toContain(removed.userId);
  });
});
