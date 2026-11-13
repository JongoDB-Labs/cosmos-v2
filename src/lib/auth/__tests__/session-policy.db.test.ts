// @vitest-environment node
//
// An org's session policy and action restrictions, enforced where every
// org-scoped route resolves its caller (getAuthContext), against a real
// database. Each setting is 0 / empty by default, which changes nothing.
//
//   maxSessionAgeMins      a session older than this stops working here,
//                          however active it has been;
//   idleTimeoutMins        one untouched for longer stops working (the same
//                          sliding window as sessionTimeoutMins; the stricter
//                          of the two applies);
//   maxConcurrentSessions  only the person's N newest live sessions work here;
//   actionRestrictions     org-wide ABAC deny rules, folded into every
//                          member's and every key's rules.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";

const h = vi.hoisted(() => ({ sessionId: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && h.sessionId ? { value: h.sessionId } : undefined) }),
  headers: async () => new Headers(),
}));

import { getAuthContext } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { apiKeyAuthContext } from "@/lib/auth/api-key";
import { requireAccess } from "@/lib/abac/require-access";
import { requirePermission } from "@/lib/rbac/check";
import { NextRequest } from "next/server";
import * as notesRoute from "@/app/api/v1/orgs/[orgId]/notes/route";
import { Permission, hasPermission } from "@/lib/rbac/permissions";

const stamp = Math.random().toString(36).slice(2, 8);
const MIN = 60_000;
let orgId = "", slug = "", userId = "", ownerId = "";
const email = `p-${stamp}@policy.test`;

async function session(opts: { ageMins: number; idleMins: number; user?: string; expiredMinsAgo?: number; passwordOnly?: boolean; legacy?: boolean }) {
  const id = randomBytes(24).toString("hex");
  const now = Date.now();
  await prisma.session.create({
    data: {
      id,
      userId: opts.user ?? userId,
      createdAt: new Date(now - opts.ageMins * MIN),
      lastActivityAt: new Date(now - opts.idleMins * MIN),
      expiresAt: opts.expiredMinsAgo ? new Date(now - opts.expiredMinsAgo * MIN) : new Date(now + 24 * 60 * MIN),
      // A first-party password sign-in: MFA-satisfied unless it stopped short of TOTP.
      // A legacy row (no authMethod) is treated as federated.
      authMethod: opts.legacy ? null : "password",
      mfaSatisfied: !opts.passwordOnly,
    },
  });
  return id;
}

async function policy(data: Partial<{ sessionTimeoutMins: number; maxSessionAgeMins: number; idleTimeoutMins: number; maxConcurrentSessions: number; mfaRequired: boolean; actionRestrictions: object }>) {
  await prisma.orgSecuritySettings.upsert({
    where: { orgId },
    create: { orgId, sessionTimeoutMins: 0, ...data },
    update: { sessionTimeoutMins: 0, maxSessionAgeMins: 0, idleTimeoutMins: 0, maxConcurrentSessions: 0, mfaRequired: false, actionRestrictions: {}, ...data },
  });
}

const as = async (sessionId: string) => {
  h.sessionId = sessionId;
  return getAuthContext(slug);
};

beforeAll(async () => {
  expect(SESSION_COOKIE).toBe("session"); // the mock above answers to this name
  slug = `pol-${stamp}`;
  orgId = (await prisma.organization.create({ data: { name: `pol ${stamp}`, slug } })).id;
  userId = (await prisma.user.create({ data: { email, displayName: "Member" } })).id;
  ownerId = (await prisma.user.create({ data: { email: `o-${stamp}@policy.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
});

beforeEach(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: [userId, ownerId] } } });
  await policy({});
  delete process.env.INTERNAL_ADMINS;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: [userId, ownerId] } } });
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [userId, ownerId] } } }).catch(() => undefined);
});

describe("with every setting at its default, nothing changes", () => {
  it("a month-old session, one of many, still works", async () => {
    for (let i = 0; i < 4; i++) await session({ ageMins: 60 + i, idleMins: 1 });
    const old = await session({ ageMins: 30 * 24 * 60, idleMins: 2 });
    expect(await as(old)).not.toBeNull();
  });
});

describe("maxSessionAgeMins", () => {
  it("refuses a session older than the cap, however active", async () => {
    await policy({ maxSessionAgeMins: 60 });
    expect(await as(await session({ ageMins: 120, idleMins: 0 }))).toBeNull();
  });

  it("lets a younger one through (positive control)", async () => {
    await policy({ maxSessionAgeMins: 60 });
    expect(await as(await session({ ageMins: 10, idleMins: 0 }))).not.toBeNull();
  });
});

describe("idleTimeoutMins", () => {
  it("refuses a session idle for longer, and ends it", async () => {
    await policy({ idleTimeoutMins: 30 });
    const id = await session({ ageMins: 60, idleMins: 45 });
    expect(await as(id)).toBeNull();
    expect(await prisma.session.findUnique({ where: { id } })).toBeNull();
  });

  it("lets an active one through (positive control)", async () => {
    await policy({ idleTimeoutMins: 30 });
    expect(await as(await session({ ageMins: 60, idleMins: 5 }))).not.toBeNull();
  });

  it("the stricter of it and sessionTimeoutMins applies", async () => {
    await policy({ idleTimeoutMins: 30, sessionTimeoutMins: 480 });
    expect(await as(await session({ ageMins: 60, idleMins: 45 }))).toBeNull();
    await policy({ idleTimeoutMins: 480, sessionTimeoutMins: 30 });
    expect(await as(await session({ ageMins: 60, idleMins: 45 }))).toBeNull();
  });

  it("a short window keeps a steadily active session alive", async () => {
    // The activity stamp is throttled; with a one-minute window it must still
    // be written often enough that a request every 40s never times out.
    await policy({ idleTimeoutMins: 1 });
    const id = await session({ ageMins: 5, idleMins: 0.67 });
    expect(await as(id)).not.toBeNull();
    const row = await prisma.session.findUniqueOrThrow({ where: { id } });
    expect(Date.now() - row.lastActivityAt.getTime()).toBeLessThan(5_000);
  });
});

describe("maxConcurrentSessions", () => {
  it("only the newest N live sessions work", async () => {
    await policy({ maxConcurrentSessions: 2 });
    const oldest = await session({ ageMins: 180, idleMins: 1 });
    const middle = await session({ ageMins: 120, idleMins: 1 });
    const newest = await session({ ageMins: 60, idleMins: 1 });
    expect(await as(oldest)).toBeNull();
    expect(await as(middle)).not.toBeNull();
    expect(await as(newest)).not.toBeNull();
  });

  it("an expired session doesn't count toward the limit", async () => {
    await policy({ maxConcurrentSessions: 1 });
    const live = await session({ ageMins: 120, idleMins: 1 });
    await session({ ageMins: 10, idleMins: 10, expiredMinsAgo: 5 });
    expect(await as(live)).not.toBeNull();
  });

  // A session this org would refuse anyway can't take a slot from one it accepts.
  it("a newer session refused for lacking MFA doesn't count", async () => {
    await policy({ mfaRequired: true, maxConcurrentSessions: 1 });
    const accepted = await session({ ageMins: 60, idleMins: 1 });
    const refused = await session({ ageMins: 1, idleMins: 0, passwordOnly: true });
    expect(await as(refused)).toBeNull();
    expect(await as(accepted)).not.toBeNull();
  });

  it("nor does a newer one idle past the limit", async () => {
    await policy({ idleTimeoutMins: 5, maxConcurrentSessions: 1 });
    const accepted = await session({ ageMins: 60, idleMins: 1 });
    await session({ ageMins: 10, idleMins: 10 });
    expect(await as(accepted)).not.toBeNull();
  });

  it("a legacy session (no sign-in method) counts, as it is accepted", async () => {
    await policy({ mfaRequired: true, maxConcurrentSessions: 1 });
    const older = await session({ ageMins: 60, idleMins: 1 });
    const legacy = await session({ ageMins: 1, idleMins: 0, legacy: true, passwordOnly: true });
    expect(await as(legacy)).not.toBeNull();
    expect(await as(older)).toBeNull();
  });

  it("a newer session the org accepts still retires the older one (control)", async () => {
    await policy({ mfaRequired: true, maxConcurrentSessions: 1 });
    const older = await session({ ageMins: 60, idleMins: 1 });
    const newer = await session({ ageMins: 1, idleMins: 0 });
    expect(await as(newer)).not.toBeNull();
    expect(await as(older)).toBeNull();
  });
});

describe("the operator's break-glass still applies", () => {
  it("an internal admin's old session passes every cap", async () => {
    await policy({ maxSessionAgeMins: 60, idleTimeoutMins: 30, maxConcurrentSessions: 1 });
    await session({ ageMins: 10, idleMins: 1 });
    const old = await session({ ageMins: 600, idleMins: 45 });
    process.env.INTERNAL_ADMINS = email;
    expect(await as(old)).not.toBeNull();
  });

  // INTERNAL_ADMINS names an address, and only a session that vouches for it
  // is the operator (isSystemAdmin). A legacy session (no sign-in method)
  // never does: it may have come from a sign-in that matched an unverified
  // address. So the caps hold it like anyone else's.
  it.each([
    ["the session age cap", { maxSessionAgeMins: 60 }, { ageMins: 600, idleMins: 1 }],
    ["the idle timeout", { idleTimeoutMins: 30 }, { ageMins: 10, idleMins: 45 }],
    ["the sessions-per-person cap", { maxConcurrentSessions: 1 }, { ageMins: 10, idleMins: 1 }],
  ] as const)("a legacy session at an internal admin's address is held to %s", async (_, limits, at) => {
    process.env.INTERNAL_ADMINS = email;
    const legacy = await session({ ...at, legacy: true });
    expect(await as(legacy)).not.toBeNull(); // with no cap, a legacy session works (control)

    await policy(limits);
    await session({ ageMins: 1, idleMins: 0 }); // a newer sign-in, which takes the one slot
    const vouching = await session(at);
    expect(await as(vouching)).not.toBeNull(); // the operator's own sign-in passes the cap (control)
    expect(await as(legacy)).toBeNull();
  });
});

describe("actionRestrictions", () => {
  // ITEM_CREATE: a bit a MEMBER holds by role, so a refusal can only come from the rule.
  const DENY_CREATE = { rules: [{ effect: "deny", actions: ["ITEM_CREATE"], conditions: [] }] };

  it("are folded into a member's rules, and deny the action", async () => {
    await policy({ actionRestrictions: DENY_CREATE });
    const ctx = await as(await session({ ageMins: 1, idleMins: 0 }));
    expect(ctx).not.toBeNull();
    expect(ctx!.abacRules).toEqual(expect.arrayContaining([expect.objectContaining({ effect: "deny", actions: ["ITEM_CREATE"] })]));
    await expect(requireAccess(ctx!, "ITEM_CREATE")).rejects.toThrow();
    await expect(requireAccess(ctx!, "ITEM_UPDATE")).resolves.toBeUndefined(); // positive control
  });

  it("reach a key the same way", async () => {
    await policy({ actionRestrictions: DENY_CREATE });
    const key = await apiKeyAuthContext(orgId, { createdById: ownerId, scopes: ["items:write", "items:delete"], projectIds: null, createdAt: new Date() });
    expect(key).not.toBeNull();
    await expect(requireAccess(key!, "ITEM_CREATE")).rejects.toThrow();
    await expect(requireAccess(key!, "ITEM_UPDATE")).resolves.toBeUndefined();
  });

  it("leave an owner's own session alone (the owner break-glass)", async () => {
    await policy({ actionRestrictions: DENY_CREATE });
    const ctx = await as(await session({ ageMins: 1, idleMins: 0, user: ownerId }));
    await expect(requireAccess(ctx!, "ITEM_CREATE")).resolves.toBeUndefined();
  });

  // A rule with no conditions is folded into the permission mask itself, so
  // the many routes and Cosmo tools that check only the bit honour it too.
  it("an unconditional one removes the bit, so a bit-only check refuses it", async () => {
    const before = await as(await session({ ageMins: 1, idleMins: 0 }));
    expect(hasPermission(before!.permissions, Permission.ITEM_CREATE)).toBe(true); // control
    await policy({ actionRestrictions: DENY_CREATE });
    const ctx = await as(await session({ ageMins: 1, idleMins: 0 }));
    expect(hasPermission(ctx!.permissions, Permission.ITEM_CREATE)).toBe(false);
    expect(() => requirePermission(ctx!, Permission.ITEM_CREATE)).toThrow();
    expect(() => requirePermission(ctx!, Permission.ITEM_UPDATE)).not.toThrow();
  });

  it("so a route that checks only the bit refuses it (notes list)", async () => {
    const sid = await session({ ageMins: 1, idleMins: 0 });
    h.sessionId = sid;
    const list = () =>
      notesRoute.GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/notes`), { params: Promise.resolve({ orgId }) });
    expect((await list()).status).toBe(200); // control
    await policy({ actionRestrictions: [{ effect: "deny", actions: ["NOTE_READ"], conditions: [] }] });
    expect((await list()).status).toBe(403);
  });

  it("an owner's key loses the bit too (keys have no break-glass)", async () => {
    await policy({ actionRestrictions: DENY_CREATE });
    const key = await apiKeyAuthContext(orgId, { createdById: ownerId, scopes: ["items:write", "items:delete"], projectIds: null, createdAt: new Date() });
    expect(hasPermission(key!.permissions, Permission.ITEM_CREATE)).toBe(false);
    expect(hasPermission(key!.permissions, Permission.ITEM_UPDATE)).toBe(true);
  });

  it("an owner's own session keeps the bit (the owner break-glass)", async () => {
    await policy({ actionRestrictions: DENY_CREATE });
    const ctx = await as(await session({ ageMins: 1, idleMins: 0, user: ownerId }));
    expect(hasPermission(ctx!.permissions, Permission.ITEM_CREATE)).toBe(true);
  });

  it("a conditional one leaves the bit, and applies where requireAccess runs", async () => {
    await policy({ actionRestrictions: [{ effect: "deny", actions: ["ITEM_CREATE"], conditions: [{ rel: "owns_resource" }] }] });
    const ctx = await as(await session({ ageMins: 1, idleMins: 0 }));
    expect(hasPermission(ctx!.permissions, Permission.ITEM_CREATE)).toBe(true);
    await expect(requireAccess(ctx!, "ITEM_CREATE", { ownerId: userId })).rejects.toThrow();
    await expect(requireAccess(ctx!, "ITEM_CREATE", { ownerId: ownerId })).resolves.toBeUndefined();
  });

  it("an empty or malformed value adds nothing", async () => {
    for (const raw of [{}, [], { rules: "no" }, { rules: [{ effect: "maybe" }] }]) {
      await policy({ actionRestrictions: raw });
      expect((await loadEffectivePermissions(orgId, userId))!.abacRules).toEqual([]);
    }
  });
});
