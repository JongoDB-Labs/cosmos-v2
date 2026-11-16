// @vitest-environment node
//
// The ceiling on current access (grant-ceiling.ts `currentAccessRefusal`) asks
// whether the caller could have granted what the target holds now. An org
// restriction with no conditions takes its bits from the caller's
// basePermissions; it takes them from the target just the same. Comparing the
// target's full role against the caller's restricted base counted a restricted
// bit as something the target holds beyond the caller, so under a restriction
// on ITEM_CREATE (which a member's role holds) no admin could change, remove or
// send a reset to a plain member.
//
// Against a real database, through the real routes and the real
// `getAuthContext`: only `next/headers` and the mail send are stood in for.
// Own org and users throughout; the seeded users are shared.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReactElement } from "react";

// Vault key for sealing the reset token.
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 21).toString("base64");

const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => {
      const m = (h.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
      return m ? { name, value: m[1] } : undefined;
    },
  }),
}));
// getAuthContext is wrapped in React's per-request `cache`; every call here is its own request.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  revalidateTag: () => undefined,
  updateTag: () => undefined,
}));
vi.mock("@/lib/integrations/invitation-email", () => ({ sendPasswordResetEmail: vi.fn(async () => undefined) }));
// The Org page renders on the server; its client parts are stood in for, so the
// props it hands the table can be read.
vi.mock("@/app/(dashboard)/[orgSlug]/team/team-table", () => ({ TeamTable: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/invite-member-button", () => ({ InviteMemberButton: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/account-request-queue", () => ({ AccountRequestQueue: () => null }));

import { prisma } from "@/lib/db/client";
import { createTestSession } from "@/lib/testing/sessions";
import { hashPassword } from "@/lib/auth/password";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { apiKeyAuthContext, scopeMask } from "@/lib/auth/api-key";
import { PUT as putMember, DELETE as deleteMember } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/route";
import { POST as sendReset } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/password-reset/route";
import { PUT as putMemberWorkRoles } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/work-roles/route";
import { PUT as putRoleRoster } from "@/app/api/v1/orgs/[orgId]/work-roles/[roleId]/members/route";
import { PUT as putWorkRole, DELETE as deleteWorkRoleRoute } from "@/app/api/v1/orgs/[orgId]/work-roles/[roleId]/route";
import { seedBuiltinWorkRoles } from "@/lib/rbac/builtin-work-roles-seed";
import TeamPage from "@/app/(dashboard)/[orgSlug]/team/page";
import { TeamTable } from "@/app/(dashboard)/[orgSlug]/team/team-table";

const stamp = Math.random().toString(36).slice(2, 8);
const slug = `rca-${stamp}`;
let orgId = "";
const users: string[] = [];
let ownerMemberId = "";
let elevatedRoleId = "";
let adminUserId = "";
let managerRoleId = "";
let contributorId = "";

/** Callers, by session cookie. The manager manages members only through a work role. */
const as = {} as Record<"owner" | "admin" | "manager", Headers>;

async function person(role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER", workRoleId?: string) {
  const n = users.length;
  const userId = (await prisma.user.create({
    data: {
      email: `p${n}-${stamp}@current-access.test`, displayName: `Person ${n}`,
      passwordHash: hashPassword("old-passphrase-1234"), passwordSetAt: new Date(),
    },
  })).id;
  users.push(userId);
  const memberId = (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: maskToDb(0n) } })).id;
  if (workRoleId) await prisma.orgMemberWorkRole.create({ data: { orgMemberId: memberId, workRoleId } });
  return { userId, memberId };
}

async function sessionFor(userId: string) {
  const token = await createTestSession({ userId, expiresAt: new Date(Date.now() + 60 * 60_000), authMethod: "password", mfaSatisfied: true });
  return new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
}

async function restrict(actions: string[]) {
  const actionRestrictions = actions.length ? [{ effect: "deny", actions, conditions: [] }] : [];
  await prisma.orgSecuritySettings.upsert({
    where: { orgId },
    create: { orgId, actionRestrictions },
    update: { actionRestrictions },
  });
}

function req(who: Headers, method: string, body?: unknown) {
  h.headers = who;
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/members/x`, {
    method,
    headers: who,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (memberId: string) => ({ params: Promise.resolve({ orgId, memberId }) });
const setRole = async (who: Headers, memberId: string, role: string) =>
  (await putMember(req(who, "PUT", { role }), params(memberId))).status;
const remove = async (who: Headers, memberId: string) => (await deleteMember(req(who, "DELETE"), params(memberId))).status;
const reset = async (who: Headers, memberId: string) => (await sendReset(req(who, "POST"), params(memberId))).status;
const roleOf = async (memberId: string) => (await prisma.orgMember.findUnique({ where: { id: memberId } }))?.role ?? null;
const roleParams = (roleId: string) => ({ params: Promise.resolve({ orgId, roleId }) });
const setWorkRoles = async (who: Headers, memberId: string, workRoleIds: string[]) =>
  (await putMemberWorkRoles(req(who, "PUT", { workRoleIds }), params(memberId))).status;
const setRoster = async (who: Headers, roleId: string, orgMemberIds: string[]) =>
  (await putRoleRoster(req(who, "PUT", { orgMemberIds }), roleParams(roleId))).status;
const editWorkRole = async (who: Headers, roleId: string, body: Record<string, unknown>) =>
  (await putWorkRole(req(who, "PUT", body), roleParams(roleId))).status;
const deleteWorkRole = async (who: Headers, roleId: string) =>
  (await deleteWorkRoleRoute(req(who, "DELETE"), roleParams(roleId))).status;
const holds = async (memberId: string, workRoleId: string) =>
  (await prisma.orgMemberWorkRole.count({ where: { orgMemberId: memberId, workRoleId } })) > 0;
const rosterOf = async (workRoleId: string) =>
  (await prisma.orgMemberWorkRole.findMany({ where: { workRoleId }, select: { orgMemberId: true } })).map((r) => r.orgMemberId);
/** The props the Org page hands its table, rendered as `who`. */
async function teamTableProps(who: Headers): Promise<{ grantableRoleIds: string[]; removableRoleIds?: string[] }> {
  h.headers = who;
  type El = ReactElement<{ children?: unknown }>;
  const suspense = TeamPage({ params: Promise.resolve({ orgSlug: slug }) }) as El;
  const content = suspense.props.children as El;
  const tree = await (content.type as (p: unknown) => Promise<unknown>)(content.props);
  const find = (n: unknown): Record<string, unknown> | null => {
    if (!n || typeof n !== "object") return null;
    const el = n as ReactElement<Record<string, unknown>>;
    if (el.type === TeamTable) return el.props;
    for (const k of ([] as unknown[]).concat(el.props?.children ?? [])) {
      const hit = find(k);
      if (hit) return hit;
    }
    return null;
  };
  const props = find(tree);
  if (!props) throw new Error("the Org page rendered no table");
  return props as { grantableRoleIds: string[]; removableRoleIds?: string[] };
}
let customRoles = 0;
async function itemWriterRole() {
  return (await prisma.workRole.create({
    data: {
      orgId, key: `writer-${stamp}-${customRoles++}`, name: `Item writer ${customRoles}`,
      grants: maskToDb(Permission.ITEM_CREATE | Permission.ITEM_READ),
    },
  })).id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `rca ${stamp}`, slug, tenantClass: "COMMERCIAL" } })).id;
  const managerRole = await prisma.workRole.create({
    data: { orgId, key: `members-${stamp}`, name: "Member manager", grants: maskToDb(Permission.ORG_MANAGE_MEMBERS) },
  });
  managerRoleId = managerRole.id;
  elevatedRoleId = (await prisma.workRole.create({
    data: { orgId, key: `security-${stamp}`, name: "Security", grants: maskToDb(Permission.SECURITY_MANAGE) },
  })).id;
  await seedBuiltinWorkRoles(orgId);
  contributorId = (await prisma.workRole.findFirstOrThrow({ where: { orgId, key: "builtin.contributor" } })).id;
  const owner = await person("OWNER");
  ownerMemberId = owner.memberId;
  as.owner = await sessionFor(owner.userId);
  adminUserId = (await person("ADMIN")).userId;
  as.admin = await sessionFor(adminUserId);
  as.manager = await sessionFor((await person("MEMBER", managerRole.id)).userId);
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

describe("under a restriction on a bit a plain member's role holds (ITEM_CREATE)", () => {
  beforeEach(() => restrict(["ITEM_CREATE"]));

  it("an admin can still change a plain member's role", async () => {
    const { memberId } = await person("MEMBER");
    expect(await setRole(as.admin, memberId, "VIEWER")).toBe(200);
    expect(await roleOf(memberId)).toBe("VIEWER");
  });

  it("an admin can still remove a plain member", async () => {
    const { memberId } = await person("MEMBER");
    expect(await roleOf(memberId)).toBe("MEMBER");
    expect(await remove(as.admin, memberId)).toBe(204);
    // Removed: the default client no longer reads the membership.
    expect(await roleOf(memberId)).toBeNull();
  });

  it("an admin, and a manager through a work role, can still send a plain member a reset", async () => {
    const { memberId } = await person("MEMBER");
    expect(await reset(as.admin, memberId)).toBe(200);
    expect(await reset(as.manager, memberId)).toBe(200);
  });

  it("an admin still can't reach an owner", async () => {
    expect(await setRole(as.admin, ownerMemberId, "ADMIN")).toBe(403);
    expect(await remove(as.admin, ownerMemberId)).toBe(403);
    expect(await reset(as.admin, ownerMemberId)).toBe(403);
    expect(await roleOf(ownerMemberId)).toBe("OWNER");
  });

  it("a manager through a work role still can't reach someone whose work role holds more", async () => {
    const { memberId } = await person("MEMBER", elevatedRoleId);
    expect(await reset(as.manager, memberId)).toBe(403);
    expect(await remove(as.manager, memberId)).toBe(403);
    expect(await roleOf(memberId)).toBe("MEMBER");
  });

  it("granting still counts every bit: an admin can't make a viewer a member while it stands", async () => {
    // A grant outlives the restriction. Lift it and the new member holds
    // ITEM_CREATE, so a grant is compared without it, as before.
    const { memberId } = await person("VIEWER");
    expect(await setRole(as.admin, memberId, "MEMBER")).toBe(403);
    expect(await roleOf(memberId)).toBe("VIEWER");
  });

  it("an owner's session is unaffected", async () => {
    const { memberId } = await person("ADMIN");
    expect(await reset(as.owner, memberId)).toBe(200);
  });
});

describe("under a restriction on the bit that puts a member beyond the manager (SECURITY_MANAGE)", () => {
  beforeEach(() => restrict(["SECURITY_MANAGE"]));

  it("a manager through a work role still can't reach the member whose work role grants it", async () => {
    // Masking the restricted bit out of BOTH sides would hide it here: the
    // target would read as a plain member, within the manager's reach, though
    // with no restriction at all they are not.
    const { memberId } = await person("MEMBER", elevatedRoleId);
    expect(await reset(as.manager, memberId)).toBe(403);
    expect(await remove(as.manager, memberId)).toBe(403);
    expect(await setRole(as.manager, memberId, "VIEWER")).toBe(403);
    expect(await roleOf(memberId)).toBe("MEMBER");
  });

  it("an admin, whose role holds it, can still reach that member", async () => {
    const { memberId } = await person("MEMBER", elevatedRoleId);
    expect(await reset(as.admin, memberId)).toBe(200);
    expect(await remove(as.admin, memberId)).toBe(204);
  });
});

describe("an API key", () => {
  beforeEach(() => restrict(["ITEM_CREATE"]));

  it("has its ceiling on current access narrowed by its scopes, as its base is", async () => {
    // No scope carries ORG_MANAGE_MEMBERS today, so no key reaches this
    // ceiling; this keeps a key from bringing its creator's whole base with it
    // the day one does.
    const scopes = ["items:write"];
    const ctx = await apiKeyAuthContext(orgId, { createdById: adminUserId, scopes, projectIds: null, createdAt: new Date() });
    expect(ctx).not.toBeNull();
    const ceiling = ctx?.unrestrictedBasePermissions;
    expect(ceiling).toBeDefined();
    expect((ceiling ?? 0n) & ~scopeMask(scopes)).toBe(0n);
    // Like with like: the restricted bit is out of the base, but not out of this.
    expect(ctx?.basePermissions ?? 0n).not.toBe(0n);
    expect((ctx?.basePermissions ?? 0n) & Permission.ITEM_CREATE).toBe(0n);
    expect((ceiling ?? 0n) & Permission.ITEM_CREATE).toBe(Permission.ITEM_CREATE);
  });
});

describe.each([
  ["with no restriction", [] as string[]],
  ["under a restriction on ITEM_CREATE", ["ITEM_CREATE"]],
])("what a manager holds through a work role never raises their ceiling (%s)", (_label, actions) => {
  beforeEach(() => restrict(actions));

  it("a manager through a work role can't reach a peer who manages members the same way", async () => {
    // The peer holds nothing the manager lacks in permissions, only in base:
    // ORG_MANAGE_MEMBERS through a work role. Counting the manager's own work
    // roles in their ceiling would put the peer within reach, and that is how
    // a self-assigned grant gets laundered into power over others.
    const peer = await person("MEMBER", managerRoleId);
    expect(await reset(as.manager, peer.memberId)).toBe(403);
    expect(await remove(as.manager, peer.memberId)).toBe(403);
    expect(await setRole(as.manager, peer.memberId, "VIEWER")).toBe(403);
    expect(await roleOf(peer.memberId)).toBe("MEMBER");
  });

  it("while the same manager still reaches a plain member", async () => {
    const a = await person("MEMBER");
    const b = await person("MEMBER");
    expect(await reset(as.manager, a.memberId)).toBe(200);
    expect(await setRole(as.manager, a.memberId, "VIEWER")).toBe(200);
    expect(await remove(as.manager, b.memberId)).toBe(204);
  });
});

describe("with no restriction", () => {
  beforeEach(() => restrict([]));

  it("an admin can change, remove and reset a plain member", async () => {
    const a = await person("MEMBER");
    const b = await person("MEMBER");
    expect(await reset(as.admin, a.memberId)).toBe(200);
    expect(await setRole(as.admin, a.memberId, "VIEWER")).toBe(200);
    expect(await remove(as.admin, b.memberId)).toBe(204);
  });

  it("an admin still can't reach an owner", async () => {
    expect(await setRole(as.admin, ownerMemberId, "ADMIN")).toBe(403);
    expect(await remove(as.admin, ownerMemberId)).toBe(403);
    expect(await reset(as.admin, ownerMemberId)).toBe(403);
  });

  it("a manager through a work role still can't reach someone whose work role holds more", async () => {
    const { memberId } = await person("MEMBER", elevatedRoleId);
    expect(await reset(as.manager, memberId)).toBe(403);
  });
});

describe("work roles under a restriction on ITEM_CREATE, which Contributor grants", () => {
  beforeEach(() => restrict(["ITEM_CREATE"]));

  it("an admin can take Contributor away from a member, as they can remove that member", async () => {
    const { memberId } = await person("MEMBER", contributorId);
    expect(await setWorkRoles(as.admin, memberId, [])).toBe(200);
    expect(await holds(memberId, contributorId)).toBe(false);
  });

  it("and can take a member off Contributor's roster", async () => {
    const off = await person("MEMBER", contributorId);
    const stays = await person("MEMBER", contributorId);
    const others = (await rosterOf(contributorId)).filter((id) => id !== off.memberId);
    expect(others).toContain(stays.memberId);
    expect(await setRoster(as.admin, contributorId, others)).toBe(200);
    expect(await holds(off.memberId, contributorId)).toBe(false);
    expect(await holds(stays.memberId, contributorId)).toBe(true);
  });

  it("but can't give Contributor while the restriction stands, either way", async () => {
    // A grant outlives the restriction, so giving it is checked as before.
    const { memberId } = await person("MEMBER");
    expect(await setWorkRoles(as.admin, memberId, [contributorId])).toBe(403);
    expect(await setRoster(as.admin, contributorId, [...(await rosterOf(contributorId)), memberId])).toBe(403);
    expect(await holds(memberId, contributorId)).toBe(false);
  });

  it("an admin can rename or delete a role that grants it, but not give a role new grants that include it", async () => {
    const roleId = await itemWriterRole();
    expect(await editWorkRole(as.admin, roleId, { name: `Renamed writer ${stamp}` })).toBe(200);
    expect(await editWorkRole(as.admin, roleId, { grants: ["ITEM_CREATE", "ITEM_READ"] })).toBe(403);
    expect(await deleteWorkRole(as.admin, roleId)).toBe(204);
    expect(await prisma.workRole.count({ where: { id: roleId } })).toBe(0);
  });

  it("the Org page offers to take Contributor away, but not to give it", async () => {
    const admin = await teamTableProps(as.admin);
    expect(admin.grantableRoleIds).not.toContain(contributorId);
    expect(admin.removableRoleIds).toContain(contributorId);
    // The manager's ceiling is their member role alone: what their own work
    // role grants doesn't count, so neither it nor Security is theirs to take.
    // An item-writer role is (control), though the restriction keeps them from
    // giving it.
    const writer = await itemWriterRole();
    const manager = await teamTableProps(as.manager);
    expect(manager.removableRoleIds).toContain(writer);
    expect(manager.grantableRoleIds).not.toContain(writer);
    expect(manager.removableRoleIds).not.toContain(elevatedRoleId);
    expect(manager.removableRoleIds).not.toContain(managerRoleId);
  });

  it("a manager through a work role still can't take away, edit or delete a role beyond their own", async () => {
    const { memberId } = await person("MEMBER", elevatedRoleId);
    expect(await setWorkRoles(as.manager, memberId, [])).toBe(403);
    expect(await setRoster(as.manager, elevatedRoleId, [])).toBe(403);
    expect(await editWorkRole(as.manager, elevatedRoleId, { name: `Renamed security ${stamp}` })).toBe(403);
    expect(await deleteWorkRole(as.manager, elevatedRoleId)).toBe(403);
    expect(await holds(memberId, elevatedRoleId)).toBe(true);
  });
});
