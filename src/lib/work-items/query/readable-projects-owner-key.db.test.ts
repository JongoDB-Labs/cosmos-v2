// @vitest-environment node
//
// `getReadableProjectIds(ctx, action)` answers "which projects may this caller
// read <action> in". An owner's API key is a credential, not the owner: its
// scopes and its project limit bind before any role shortcut, as they do in
// `evaluateAccess`. The shortcut returned every project for an owner's key
// whatever the action, so a key without a register's scope still had that
// register's projects listed for it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { getReadableProjectIds } from "./scope";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", owner = "", P = "", Q = "";

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@rpok.test`, displayName: "Owner" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `rpok ${stamp}`, slug: `rpok-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  P = (await prisma.project.create({ data: { orgId, name: "P", key: `KP${stamp.slice(0, 3).toUpperCase()}` } })).id;
  Q = (await prisma.project.create({ data: { orgId, name: "Q", key: `KQ${stamp.slice(0, 3).toUpperCase()}` } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner } }).catch(() => undefined);
});

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: owner, orgId, orgRole: "OWNER", abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER, ...over,
});
const sorted = async (p: Promise<string[]>) => (await p).sort();

describe("an owner's key reads only what its scopes and project limit allow", () => {
  it("control: the owner in person reads every project", async () => {
    expect(await sorted(getReadableProjectIds(ctx(), "ANALYTICS_READ"))).toEqual([P, Q].sort());
  });

  it("a key whose scopes leave out the action gets no project for it", async () => {
    const key = ctx({ isApiKey: true, permissions: Permission.ORG_READ | Permission.PROJECT_READ | Permission.ITEM_READ });
    expect(await getReadableProjectIds(key, "ANALYTICS_READ")).toEqual([]);
    // Control: the same key still reads the actions it was given.
    expect(await sorted(getReadableProjectIds(key, "ITEM_READ"))).toEqual([P, Q].sort());
  });

  it("a deny rule binds the owner's key, though not the owner in person", async () => {
    const denyQ = [{ effect: "deny", actions: ["ANALYTICS_READ"], conditions: [{ attr: "projectId", op: "eq", value: Q }] }] as AbacRule[];
    // The owner is exempt from rules (break-glass), as evaluateAccess has it...
    expect(await sorted(getReadableProjectIds(ctx({ abacRules: denyQ }), "ANALYTICS_READ"))).toEqual([P, Q].sort());
    // ...a key minted by the owner is not.
    expect(await getReadableProjectIds(ctx({ abacRules: denyQ, isApiKey: true }), "ANALYTICS_READ")).toEqual([P]);
  });

  it("a key limited to one project gets that one, for an action it holds", async () => {
    const key = ctx({ isApiKey: true, projectScope: [P], permissions: Permission.ORG_READ | Permission.ANALYTICS_READ });
    expect(await getReadableProjectIds(key, "ANALYTICS_READ")).toEqual([P]);
  });
});
