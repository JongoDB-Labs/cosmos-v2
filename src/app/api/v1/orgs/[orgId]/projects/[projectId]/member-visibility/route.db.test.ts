// @vitest-environment node
//
// Which org members can see a project, for the assignee picker: it marks the
// people who can't, and the detail sheet warns when one is assigned, since
// they won't be told about it (or be able to open it). Asked as each member,
// with the rule that decides whether an assignment notification reaches them,
// so the warning and the silence can't disagree. Only to someone who may
// already change work items in the project, and only a yes or no per member
// of the org: never to an API key, never about anyone outside the org.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/notifications/push", () => ({ pushToUser: async () => undefined }));

const { GET } = await import("./route");
const { PATCH: patchItem } = await import("@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route");
const { loadMemberAuthContext } = await import("@/lib/rbac/effective-permissions");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", otherOrgId = "", projectId = "", openProjectId = "", typeId = "";
let owner = "", admin = "", insider = "", outsider = "", denied = "", viewer = "", leaver = "", stranger = "";
const users: string[] = [];

const OWNER_CTX = () => ({ userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] }) satisfies AuthContext;

beforeAll(async () => {
  const mk = async (n: string) => {
    const u = await prisma.user.create({ data: { email: `${n}-${stamp}@reach.test`, displayName: n } });
    users.push(u.id);
    return u.id;
  };
  [owner, admin, insider, outsider, denied, viewer, leaver, stranger] = await Promise.all(
    ["owner", "admin", "insider", "outsider", "denied", "viewer", "leaver", "stranger"].map(mk),
  );
  orgId = (await prisma.organization.create({ data: { name: `reach ${stamp}`, slug: `reach-${stamp}` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `reach2 ${stamp}`, slug: `reach2-${stamp}` } })).id;
  const key = `RV${stamp.slice(0, 3).toUpperCase()}`;
  projectId = (await prisma.project.create({ data: { orgId, name: "Restricted", key, teamScopedAccess: true } })).id;
  openProjectId = (await prisma.project.create({ data: { orgId, name: "Open", key: `${key}O` } })).id;

  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: admin, role: "ADMIN", permissions: "0" } });
  const ins = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  // On the project, but a policy forbids them its work items.
  const den = await prisma.orgMember.create({
    data: {
      orgId, userId: denied, role: "MEMBER", permissions: "0",
      abacRules: [{ effect: "deny", actions: ["ITEM_READ"], conditions: [{ attr: "projectId", op: "eq", value: projectId }] }] as never,
    },
  });
  const vw = await prisma.orgMember.create({ data: { orgId, userId: viewer, role: "VIEWER", permissions: "0" } });
  // Left the org: not someone the picker lists.
  await prisma.orgMember.create({ data: { orgId, userId: leaver, role: "MEMBER", permissions: "0", removedAt: new Date() } });
  // Someone else's member entirely.
  await prisma.orgMember.create({ data: { orgId: otherOrgId, userId: stranger, role: "MEMBER", permissions: "0" } });
  for (const m of [ins, den, vw]) await prisma.projectMember.create({ data: { projectId, orgMemberId: m.id } });

  await ensureFixtureStatuses(projectId);
  await ensureFixtureStatuses(openProjectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

beforeEach(async () => {
  h.ctx = OWNER_CTX();
  await prisma.notification.deleteMany({ where: { orgId } });
});

const get = (pid = projectId, org = orgId) =>
  GET(new NextRequest(`http://localhost/api/v1/orgs/${org}/projects/${pid}/member-visibility`), {
    params: Promise.resolve({ orgId: org, projectId: pid }),
  });
async function visibility(pid = projectId): Promise<Record<string, boolean>> {
  const res = await get(pid);
  expect(res.status).toBe(200);
  const rows = (await res.json()) as { userId: string; canSee: boolean }[];
  return Object.fromEntries(rows.map((r) => [r.userId, r.canSee]));
}
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("which members can see a project, for the assignee picker (e2e DB)", () => {
  it("in a team-scoped project: its members and the org's administrators can; anyone else, or one a policy denies, can't", async () => {
    const v = await visibility();
    expect(v).toEqual({ [owner]: true, [admin]: true, [insider]: true, [viewer]: true, [outsider]: false, [denied]: false });
  });

  it("in a project open to everyone, every member can", async () => {
    const v = await visibility(openProjectId);
    expect(Object.keys(v).sort()).toEqual([owner, admin, insider, outsider, denied, viewer].sort());
    expect(Object.values(v).every(Boolean)).toBe(true);
  });

  it("agrees with the notification: each member it says can't see the project hears nothing of an assignment, and each one it says can, does", async () => {
    const v = await visibility();
    for (const [userId, canSee] of Object.entries(v)) {
      if (userId === owner) continue; // the assigner is never told about their own change
      const x = await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title: `For ${userId}`, columnKey: "todo" });
      expect((await patchItem(json("PATCH", { assigneeId: userId }), { params: Promise.resolve({ orgId, itemId: x.id }) })).status).toBe(200);
      const told = await prisma.notification.count({ where: { orgId, userId, type: "work_item.assigned", refId: x.id } });
      expect({ userId, told: told === 1 }).toEqual({ userId, told: canSee });
    }
  });

  it("only to someone who may change work items in the project", async () => {
    // A viewer can see the project but not change its items.
    h.ctx = await loadMemberAuthContext(orgId, viewer);
    expect((await get()).status).toBe(403);
    // A member who can't see the project at all.
    h.ctx = await loadMemberAuthContext(orgId, outsider);
    expect((await get()).status).toBe(403);
    // Positive control: a member on the project, who can.
    h.ctx = await loadMemberAuthContext(orgId, insider);
    expect((await get()).status).toBe(200);
  });

  it("never to an API key, even one that may change work items", async () => {
    h.ctx = { ...OWNER_CTX(), isApiKey: true, scopes: ["items:write"] } satisfies AuthContext;
    expect((await get()).status).toBe(403);
  });

  it("a project of another org, or a missing one, is refused like one they can't see", async () => {
    const foreign = (await prisma.project.create({ data: { orgId: otherOrgId, name: "Theirs", key: `RX${stamp.slice(0, 3).toUpperCase()}` } })).id;
    expect((await get(foreign)).status).toBe(403);
    expect((await get(crypto.randomUUID())).status).toBe(403);
  });
});
