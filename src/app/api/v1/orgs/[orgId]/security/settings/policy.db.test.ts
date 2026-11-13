// @vitest-environment node
//
// The session caps and action restrictions an org sets on its security
// settings page, through the route that page saves with, against a real
// database. 0 (or an empty list) turns each one off. A restriction is checked
// strictly: one with an unknown action, attribute or shape is refused with
// the index of the rule, because the engine would otherwise drop it and
// quietly restrict nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => h.ctx,
  getCurrentUser: async () => null,
  revokeOrgSessions: async () => 0,
}));

import { GET, PUT } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", adminId = "", memberId = "";

const admin = (): AuthContext => ({
  userId: adminId, orgId, orgRole: OrgRole.ADMIN, abacRules: [],
  permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN,
});
const member = (): AuthContext => ({
  userId: memberId, orgId, orgRole: OrgRole.MEMBER, abacRules: [],
  permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER,
});
const at = () => ({ params: Promise.resolve({ orgId }) });
const put = (body: unknown) =>
  PUT(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/security/settings`, {
    method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }), at());
const stored = () => prisma.orgSecuritySettings.findUniqueOrThrow({ where: { orgId } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `secset ${stamp}`, slug: `secset-${stamp}` } })).id;
  adminId = (await prisma.user.create({ data: { email: `a-${stamp}@secset.test`, displayName: "Admin" } })).id;
  memberId = (await prisma.user.create({ data: { email: `m-${stamp}@secset.test`, displayName: "Member" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: adminId, role: "ADMIN", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: memberId, role: "MEMBER", permissions: "0" } });
});

afterAll(async () => {
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId } });
  await prisma.orgMember.deleteMany({ where: { orgId } });
  // Audit rows are append-only, so an org that wrote some may not delete.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId] } } }).catch(() => undefined);
});

describe("session caps", () => {
  it("are saved, and 0 turns each off", async () => {
    h.ctx = admin();
    expect((await put({ maxSessionAgeMins: 720, idleTimeoutMins: 30, maxConcurrentSessions: 3 })).status).toBe(200);
    expect(await stored()).toMatchObject({ maxSessionAgeMins: 720, idleTimeoutMins: 30, maxConcurrentSessions: 3 });
    expect((await put({ maxSessionAgeMins: 0, idleTimeoutMins: 0, maxConcurrentSessions: 0 })).status).toBe(200);
    expect(await stored()).toMatchObject({ maxSessionAgeMins: 0, idleTimeoutMins: 0, maxConcurrentSessions: 0 });
  });

  it.each([
    [{ maxSessionAgeMins: 14 }],
    [{ idleTimeoutMins: 4 }],
    [{ maxConcurrentSessions: -1 }],
    [{ maxSessionAgeMins: 30.5 }],
    [{ idleTimeoutMins: "10" }],
  ])("refuses %j and changes nothing", async (body) => {
    h.ctx = admin();
    await put({ maxSessionAgeMins: 60, idleTimeoutMins: 10, maxConcurrentSessions: 2 });
    expect((await put(body)).status).toBe(400);
    expect(await stored()).toMatchObject({ maxSessionAgeMins: 60, idleTimeoutMins: 10, maxConcurrentSessions: 2 });
  });

  it("need SECURITY_MANAGE (a member is refused)", async () => {
    h.ctx = member();
    expect((await put({ maxConcurrentSessions: 1 })).status).toBe(403);
  });
});

describe("action restrictions", () => {
  const DENY_DELETE = { effect: "deny", actions: ["ITEM_DELETE"], conditions: [] };
  const DENY_OWN = { effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ rel: "owns_resource" }] };

  it("are saved, read back, and reach every member's rules", async () => {
    h.ctx = admin();
    const res = await put({ actionRestrictions: [DENY_DELETE, DENY_OWN] });
    expect(res.status).toBe(200);
    expect((await stored()).actionRestrictions).toEqual([DENY_DELETE, DENY_OWN]);
    const read = (await (await GET(new NextRequest("http://localhost/x"), at())).json()) as { actionRestrictions: unknown };
    expect(read.actionRestrictions).toEqual([DENY_DELETE, DENY_OWN]);
    const eff = await loadEffectivePermissions(orgId, memberId);
    expect(eff!.abacRules).toEqual(expect.arrayContaining([expect.objectContaining({ actions: ["ITEM_UPDATE"] })]));
  });

  it("an empty list turns them off", async () => {
    h.ctx = admin();
    expect((await put({ actionRestrictions: [] })).status).toBe(200);
    expect((await stored()).actionRestrictions).toEqual([]);
  });

  it.each([
    ["an unknown action", [DENY_DELETE, { effect: "deny", actions: ["ITEM_DELET"], conditions: [] }], 1, /unknown action "ITEM_DELET"/],
    ["an unknown attribute", [{ effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ attr: "projctId", op: "eq", value: "x" }] }], 0, /unknown attribute "projctId"/],
    ["an unknown relationship", [DENY_DELETE, DENY_OWN, { effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ rel: "same_department" }] }], 2, /unknown relationship/],
    ["missing conditions", [{ effect: "deny", actions: ["ITEM_UPDATE"] }], 0, /conditions must be a list/],
    ["an allow rule", [{ effect: "allow", actions: ["ITEM_UPDATE"], conditions: [] }], 0, /only deny/],
    ["no actions", [{ effect: "deny", actions: [], conditions: [] }], 0, /at least one action/],
    ["a set operator with one value", [{ effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ attr: "projectId", op: "in", value: "x" }] }], 0, /needs a list/],
    ["an unknown field", [{ effect: "deny", actions: ["ITEM_UPDATE"], conditions: [], when: "always" }], 0, /unknown field "when"/],
  ])("refuses %s with the rule's index, and keeps what was there", async (_name, rules, index, message) => {
    h.ctx = admin();
    await put({ actionRestrictions: [DENY_DELETE] });
    const res = await put({ actionRestrictions: rules });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; ruleIndex: number };
    expect(body.ruleIndex).toBe(index);
    expect(body.error).toMatch(message);
    expect(body.error).toContain(`Rule ${index + 1}`);
    expect((await stored()).actionRestrictions).toEqual([DENY_DELETE]);
  });

  it("refuses a value that isn't a list", async () => {
    h.ctx = admin();
    const res = await put({ actionRestrictions: { rules: [DENY_DELETE] } });
    expect(res.status).toBe(400);
  });
});

describe("every change is audited, with the new values", () => {
  it("records the caps and how many restrictions, and never the rules' text", async () => {
    h.ctx = admin();
    const since = new Date();
    await put({ maxSessionAgeMins: 480, idleTimeoutMins: 20, maxConcurrentSessions: 4, actionRestrictions: [{ effect: "deny", actions: ["ITEM_DELETE"], conditions: [] }] });
    const rows = await prisma.auditLog.findMany({
      where: { orgId, action: "security_settings.updated", createdAt: { gte: since } },
      select: { metadata: true, userId: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(adminId);
    expect(rows[0].metadata).toMatchObject({
      maxSessionAgeMins: "480", idleTimeoutMins: "20", maxConcurrentSessions: "4", actionRestrictions: "1 rule",
    });
  });
});
