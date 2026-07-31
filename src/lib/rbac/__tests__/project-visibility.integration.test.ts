// @vitest-environment node
//
// END-TO-END check of the "limit visibility to project members" toggle, against
// a REAL database.
//
// Every other test of this feature mocks Prisma, so they prove the logic and not
// the wiring — and wiring is exactly what kept failing here. The flag leaked
// FOUR times, each in a surface the previous sweep had no reason to look at: the
// projects list, portfolio analytics, the project pages, and then the whole
// Issues/facets/activity/mentions/AI family via a second, older helper that
// predated the flag. Each fix was correct; each guard was shaped like the fix
// that preceded it.
//
// So this seeds the real shape and asks the real helpers, with no mocks:
//
//   OWNER          sees it   — break-glass, deliberate
//   PROJECT_MANAGE sees it   — admins keep access, deliberate (org ADMIN has it)
//   MEMBER, on it  sees it
//   MEMBER, not on it  DOES NOT SEE IT  ← the whole point
//
// The admin cases are asserted as loudly as the denial: someone reading a leak
// report should be able to tell "an admin can still see it" from "the gate is
// broken" without re-deriving the design.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import {
  isProjectVisible,
  getVisibleProjectIds,
  visibleProjectIdsForActor,
} from "@/lib/rbac/project-access";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

const TAG = "vis-int";

let orgId = "";
let restrictedId = "";
let openId = "";
const actors: Record<string, AuthContext> = {};

async function makeActor(
  label: string,
  role: OrgRole,
  perms: bigint,
  onProject: string | null,
): Promise<AuthContext> {
  const user = await prisma.user.create({
    data: { email: `${TAG}-${label}-${Date.now()}@example.com`, displayName: `${label}` },
  });
  const om = await prisma.orgMember.create({
    data: { orgId, userId: user.id, role, permissions: maskToDb(perms) },
  });
  if (onProject) {
    await prisma.projectMember.create({
      data: { projectId: onProject, orgMemberId: om.id },
    });
  }
  return {
    userId: user.id,
    orgId,
    orgRole: role,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `${TAG} org`, slug: `${TAG}-${Date.now()}` },
  });
  orgId = org.id;

  const restricted = await prisma.project.create({
    data: { orgId, name: "Restricted", key: "RSTR", teamScopedAccess: true },
  });
  const open = await prisma.project.create({
    data: { orgId, name: "Open", key: "OPEN", teamScopedAccess: false },
  });
  restrictedId = restricted.id;
  openId = open.id;

  // The read bits an ordinary member holds. Deliberately NOT PROJECT_MANAGE.
  const base = Permission.PROJECT_READ | Permission.ITEM_READ;

  actors.owner = await makeActor("owner", OrgRole.OWNER, base, null);
  actors.admin = await makeActor("admin", OrgRole.ADMIN, base | Permission.PROJECT_MANAGE, null);
  actors.memberOn = await makeActor("member-on", OrgRole.MEMBER, base, restrictedId);
  actors.memberOff = await makeActor("member-off", OrgRole.MEMBER, base, null);
});

afterAll(async () => {
  if (!orgId) return;
  await prisma.projectMember.deleteMany({ where: { project: { orgId } } });
  await prisma.project.deleteMany({ where: { orgId } });
  const members = await prisma.orgMember.findMany({ where: { orgId }, select: { userId: true } });
  await prisma.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: members.map((m) => m.userId) } } });
});

describe("visibility toggle — a MEMBER who is not on the project", () => {
  it("cannot see it via isProjectVisible (the per-project gate)", async () => {
    await expect(isProjectVisible(actors.memberOff, restrictedId)).resolves.toBe(false);
  });

  it("cannot see it in getVisibleProjectIds (list views)", async () => {
    const ids = await getVisibleProjectIds(actors.memberOff, [restrictedId, openId]);
    expect(ids.has(restrictedId)).toBe(false);
    expect(ids.has(openId)).toBe(true);
  });

  it("cannot see it in visibleProjectIdsForActor (mentions, AI tools)", async () => {
    const ids = await visibleProjectIdsForActor(orgId, actors.memberOff.userId, [
      restrictedId,
      openId,
    ]);
    expect(ids.has(restrictedId)).toBe(false);
    expect(ids.has(openId)).toBe(true);
  });

  it("cannot see it in getReadableProjectIds (Issues, facets, activity, export)", async () => {
    // The helper behind the FOURTH leak, and a different one from the three
    // above — same question, older code path.
    const ids = await getReadableProjectIds(actors.memberOff);
    expect(ids).not.toContain(restrictedId);
    expect(ids).toContain(openId);
  });
});

describe("visibility toggle — everyone who SHOULD still see it", () => {
  it("a MEMBER who is on the project sees it everywhere", async () => {
    const a = actors.memberOn;
    expect(await isProjectVisible(a, restrictedId)).toBe(true);
    expect((await getVisibleProjectIds(a, [restrictedId])).has(restrictedId)).toBe(true);
    expect((await visibleProjectIdsForActor(orgId, a.userId, [restrictedId])).has(restrictedId)).toBe(true);
    expect(await getReadableProjectIds(a)).toContain(restrictedId);
  });

  it("the org OWNER sees it — break-glass, by design", async () => {
    const a = actors.owner;
    expect(await isProjectVisible(a, restrictedId)).toBe(true);
    expect(await getReadableProjectIds(a)).toContain(restrictedId);
  });

  it("a PROJECT_MANAGE holder sees it — org admins keep access, by design", async () => {
    // Worth asserting loudly: an org ADMIN carries PROJECT_MANAGE, so admins do
    // NOT lose sight of a restricted project. Someone reporting "I can still see
    // it" from an admin account is seeing the design, not a leak.
    const a = actors.admin;
    expect(await isProjectVisible(a, restrictedId)).toBe(true);
    expect(await getReadableProjectIds(a)).toContain(restrictedId);
  });
});

describe("an unrestricted project is unaffected for everyone", () => {
  it("stays visible to a plain member who is on nothing", async () => {
    // The reason existing orgs saw no behaviour change when this shipped.
    expect(await isProjectVisible(actors.memberOff, openId)).toBe(true);
  });
});
