// @vitest-environment node
//
// A rule acts as its owner, capped at what the owner held when they last saved
// it (`actorCap`). Every mask on the context has to carry that cap, including
// the ceiling on current access (`unrestrictedBasePermissions`): a context
// that spread the owner's access and capped only some of it would carry the
// owner's whole ceiling into anything that asks it. Against a real database;
// own org and user, the seeded users are shared.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import { currentAccessRefusal } from "@/lib/rbac/grant-ceiling";
import { ruleContext } from "./principal.server";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
let ownerId = "";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `rule ctx ${stamp}`, slug: `rulectx-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `rule-${stamp}@rule-ctx.test`, displayName: "Rule owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "ADMIN", permissions: "0" } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
});

describe("a rule's context is capped in every mask", () => {
  it("capped at ITEM_READ, it can't change or remove an admin, though its owner could", async () => {
    const ctx = await ruleContext({ orgId, ownerId, actorCap: maskToDb(Permission.ITEM_READ) });
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    expect(ctx.basePermissions & ~Permission.ITEM_READ).toBe(0n);
    expect((ctx.unrestrictedBasePermissions ?? ctx.basePermissions) & ~Permission.ITEM_READ).toBe(0n);
    expect(currentAccessRefusal(ctx, "ADMIN")).not.toBeNull();
  });

  it("capped at the admin's own access, it reaches a member", async () => {
    // Positive control: the cap is what refuses above, not the context.
    const ctx = await ruleContext({ orgId, ownerId, actorCap: maskToDb(RolePermissions.ADMIN) });
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    expect(currentAccessRefusal(ctx, "MEMBER")).toBeNull();
  });
});
