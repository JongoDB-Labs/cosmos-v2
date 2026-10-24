// @vitest-environment node
//
// A project that opts into teamScopedAccess is hidden from org members outside
// its team: the reads refused them, but 32 writes didn't ask. An outsider could
// create items there, and delete, duplicate (which echoes the source) and
// comment on its items by id. Every project write now asks the visibility
// question first. Through the real routes, against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { DELETE as deleteItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { POST as duplicate } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/duplicate/route";
import { POST as comment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route";
import { POST as createBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import { POST as createObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/route";
import { DELETE as deleteById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route";
import { POST as commentById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/comments/route";

const stamp = Math.random().toString(36).slice(2, 8);
const SECRET_TITLE = `restricted-${stamp}`;
let orgId = "", restricted = "", open = "", outsider = "", insider = "", typeId = "";

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@tsw.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@tsw.test`, displayName: "Insider" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `tsw ${stamp}`, slug: `tsw-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (await prisma.project.create({ data: { orgId, name: "R", key: `TR${key}`, teamScopedAccess: true } })).id;
  open = (await prisma.project.create({ data: { orgId, name: "O", key: `TO${key}` } })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
  await ensureFixtureStatuses(restricted);
  await ensureFixtureStatuses(open);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [outsider, insider] } } }).catch(() => undefined);
});

/** An ordinary member's session: the MEMBER role's bits, plus any a work role adds. */
const member = (userId: string, extra = 0n): AuthContext => ({
  userId, orgId, orgRole: "MEMBER", abacRules: [],
  permissions: RolePermissions.MEMBER | extra, basePermissions: RolePermissions.MEMBER | extra,
});
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const inProject = (projectId: string) => ({ params: Promise.resolve({ orgId, projectId }) });
const onItem = (projectId: string, itemId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId }) });
const byId = (itemId: string) => ({ params: Promise.resolve({ orgId, itemId }) });
const item = (projectId: string) =>
  createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: insider, title: SECRET_TITLE, columnKey: "todo" });
const newItem = () => ({ title: "x", columnKey: "todo", workItemTypeId: typeId });

describe("an org member outside a team-scoped project can't write in it", () => {
  it("can't create an item, a board or an objective there", async () => {
    h.ctx = member(outsider);
    const before = await prisma.workItem.count({ where: { projectId: restricted } });
    expect((await createItem(req("POST", newItem()), inProject(restricted))).status).toBe(403);
    expect((await createBoard(req("POST", { name: "b" }), inProject(restricted))).status).toBe(403);
    // Gated by requireProjectManage on OKR_CREATE, a bit every member holds.
    expect((await createObjective(req("POST", { title: "o" }), inProject(restricted))).status).toBe(403);
    expect(await prisma.workItem.count({ where: { projectId: restricted } })).toBe(before);
    expect(await prisma.board.count({ where: { projectId: restricted } })).toBe(0);
    expect(await prisma.objective.count({ where: { projectId: restricted } })).toBe(0);
  });

  it("can't duplicate an item, which would hand back its contents", async () => {
    const a = await item(restricted);
    h.ctx = member(outsider);
    const res = await duplicate(req("POST"), onItem(restricted, a.id));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET_TITLE);
    expect(await prisma.workItem.count({ where: { orgId, title: `Copy of ${SECRET_TITLE}` } })).toBe(0);
  });

  it("can't comment on an item, through the project path or by id", async () => {
    const a = await item(restricted);
    h.ctx = member(outsider);
    expect((await comment(req("POST", { content: "hi" }), onItem(restricted, a.id))).status).toBe(403);
    // By id, an item the caller can't read is the same 404 as a missing one.
    expect((await commentById(req("POST", { content: "hi" }), byId(a.id))).status).toBe(404);
    expect(await prisma.comment.count({ where: { workItemId: a.id } })).toBe(0);
  });

  it("can't delete an item, through the project path or by id, even granted ITEM_DELETE", async () => {
    // MEMBER lacks ITEM_DELETE, so without the grant this would pass unfixed.
    const a = await item(restricted);
    h.ctx = member(outsider, Permission.ITEM_DELETE);
    expect((await deleteItem(req("DELETE"), onItem(restricted, a.id))).status).toBe(403);
    expect((await deleteById(req("DELETE"), byId(a.id))).status).toBe(403);
    expect(await prisma.workItem.count({ where: { id: a.id } })).toBe(1);
  });

  it("a real id and a made-up one answer the same", async () => {
    // The check runs before the lookup, so the status can't reveal what exists.
    const a = await item(restricted);
    h.ctx = member(outsider);
    const real = await duplicate(req("POST"), onItem(restricted, a.id));
    const fake = await duplicate(req("POST"), onItem(restricted, "9f8e7d6c-5b4a-4321-8fed-cba987654321"));
    expect([real.status, fake.status]).toEqual([403, 403]);
  });
});

describe("everyone else is unaffected", () => {
  it("a member of the team writes there as before", async () => {
    h.ctx = member(insider);
    expect((await createItem(req("POST", newItem()), inProject(restricted))).status).toBe(201);
    const a = await item(restricted);
    expect((await comment(req("POST", { content: "hi" }), onItem(restricted, a.id))).status).toBe(201);
    expect((await duplicate(req("POST"), onItem(restricted, a.id))).status).toBe(201);
  });

  it("on a project that isn't team-scoped, any member writes as before", async () => {
    h.ctx = member(outsider);
    expect((await createItem(req("POST", newItem()), inProject(open))).status).toBe(201);
    const a = await item(open);
    expect((await comment(req("POST", { content: "hi" }), onItem(open, a.id))).status).toBe(201);
    expect((await createObjective(req("POST", { title: "o" }), inProject(open))).status).toBe(200);
  });
});
