// @vitest-environment node
//
// The merge answer shows each item's linked items the way reading the item
// does: a sub-item in a project the caller can't open reads as no sub-item.
// Writes now hold a parent to the item's own project, but rows written before
// that can sit under an item from a team-scoped project; they are planted here
// the way those rows were written, straight into the table. Against a real
// database, with own users and org.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as merge } from "./route";
import { GET as readItem } from "../route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", openId = "", hiddenId = "", typeId = "", owner = "", member = "";

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@merge-scope.test`, displayName: "Owner" } })).id;
  member = (await prisma.user.create({ data: { email: `member-${stamp}@merge-scope.test`, displayName: "Member" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ms ${stamp}`, slug: `ms-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: member, role: "MEMBER", permissions: "0" } });
  const key = `MS${stamp.slice(0, 3).toUpperCase()}`;
  openId = (await prisma.project.create({ data: { orgId, name: "Open", key } })).id;
  // Team-scoped, and the member is not on it.
  hiddenId = (await prisma.project.create({ data: { orgId, name: "Team only", key: `${key}H`, teamScopedAccess: true } })).id;
  await ensureFixtureStatuses(openId);
  await ensureFixtureStatuses(hiddenId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, member] } } }).catch(() => undefined);
});

const item = (projectId: string, title: string) =>
  createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title, columnKey: "todo" });
/** Parent `childId` under `parentId` directly in the table, as rows written before parents were checked. */
const plantUnder = (childId: string, parentId: string) =>
  prisma.$executeRaw`UPDATE work_items SET parent_id = ${parentId}::uuid WHERE id = ${childId}::uuid`;
const childIds = (row: { children?: { id: string }[] }) => (row.children ?? []).map((c) => c.id).sort();

describe("merge answers with the linked items its caller may see", () => {
  it("drops a sub-item in a project the caller can't open, from both items, and keeps a visible one", async () => {
    const survivor = await item(openId, "survivor");
    const dup = await item(openId, "duplicate");
    const sibling = await item(openId, "visible sibling");
    const hiddenUnderSurvivor = await item(hiddenId, "hidden under survivor");
    const hiddenUnderDup = await item(hiddenId, "hidden under duplicate");
    expect(await plantUnder(sibling.id, survivor.id)).toBe(1);
    expect(await plantUnder(hiddenUnderSurvivor.id, survivor.id)).toBe(1);
    expect(await plantUnder(hiddenUnderDup.id, dup.id)).toBe(1);

    h.ctx = await loadMemberAuthContext(orgId, member);
    const res = await merge(
      new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ intoId: survivor.id }), headers: { "Content-Type": "application/json" } }),
      { params: Promise.resolve({ orgId, projectId: openId, itemId: dup.id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: { children?: { id: string }[] }; into: { children?: { id: string }[] } };
    expect(childIds(body.into)).toEqual([sibling.id]);
    expect(childIds(body.merged)).toEqual([]);

    // Reading the survivor says the same.
    const read = await readItem(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId: openId, itemId: survivor.id }) });
    expect(read.status).toBe(200);
    expect(childIds(await read.json())).toEqual([sibling.id]);

    // Control: the hidden sub-items are really there, and someone who can open
    // their project sees them under the same items.
    h.ctx = await loadMemberAuthContext(orgId, owner);
    const ownerRead = await readItem(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId: openId, itemId: survivor.id }) });
    expect(childIds(await ownerRead.json())).toEqual([sibling.id, hiddenUnderSurvivor.id].sort());
    const ownerDup = await readItem(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId: openId, itemId: dup.id }) });
    expect(childIds(await ownerDup.json())).toEqual([hiddenUnderDup.id]);
  });
});
