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
import { randomBytes } from "node:crypto";

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

import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { apiKeyAuthContext, scopeMask } from "@/lib/auth/api-key";
import { PUT as putMember, DELETE as deleteMember } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/route";
import { POST as sendReset } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/password-reset/route";

const stamp = Math.random().toString(36).slice(2, 8);
const slug = `rca-${stamp}`;
let orgId = "";
const users: string[] = [];
let ownerMemberId = "";
let elevatedRoleId = "";
let adminUserId = "";

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
  const id = randomBytes(24).toString("hex");
  await prisma.session.create({
    data: { id, userId, expiresAt: new Date(Date.now() + 60 * 60_000), authMethod: "password", mfaSatisfied: true },
  });
  return new Headers({ cookie: `${SESSION_COOKIE}=${id}` });
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

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `rca ${stamp}`, slug, tenantClass: "COMMERCIAL" } })).id;
  const managerRole = await prisma.workRole.create({
    data: { orgId, key: `members-${stamp}`, name: "Member manager", grants: maskToDb(Permission.ORG_MANAGE_MEMBERS) },
  });
  elevatedRoleId = (await prisma.workRole.create({
    data: { orgId, key: `security-${stamp}`, name: "Security", grants: maskToDb(Permission.SECURITY_MANAGE) },
  })).id;
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
