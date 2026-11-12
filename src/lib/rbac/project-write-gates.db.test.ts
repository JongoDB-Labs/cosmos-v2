// @vitest-environment node
//
// Project-level writes have to ask the same two questions as reads before any
// org-wide bit or admin standing is allowed to settle them: is this project
// inside the caller's API-key ceiling, and can the caller see it at all (a
// team-scoped project is closed to non-members)? And a change to who runs a
// project is an access-control action, not a roster edit.
//
// Through the real routes, against a real database. Each refusal sits beside a
// positive control: the same caller doing the legitimate version succeeds.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { Permission } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// Outside a Next request there is no cache store to revalidate.
vi.mock("@/lib/cache/queries", async (orig) => ({ ...(await orig<object>()), revalidateOrgProjects: vi.fn() }));

import { PUT as putProject } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/route";
import { POST as importInto } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/import/route";
import { PATCH as patchStaff } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/staffing/[memberId]/route";
import { PUT as putColumns } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/columns/route";
import { POST as addWidget } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/dashboard-widgets/route";
import { DELETE as bulkDelete, PUT as bulkPut } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();

let orgId = "", owner = "", admin = "", member = "", other = "";
let memberOm = "", otherOm = "";
// p1 and p2 are open; closed is team-scoped and `member` is not on it.
let p1 = "", p2 = "", closed = "";
let typeId = "";

const sessionOf = (userId: string, orgRole: AuthContext["orgRole"], permissions: bigint, abacRules: AbacRule[] = []): AuthContext => ({
  userId, orgId, orgRole, permissions, basePermissions: permissions, abacRules,
});
const ownerKey = (scopes: string[], projects?: string[]): AuthContext => ({
  userId: owner, orgId, orgRole: "OWNER", abacRules: [],
  permissions: scopeMask(scopes), basePermissions: scopeMask(scopes),
  isApiKey: true, scopes, ...(projects && { projectScope: projects }),
});
const MEMBER_BITS = Permission.ORG_READ | Permission.PROJECT_READ | Permission.ITEM_READ | Permission.ITEM_UPDATE | Permission.BOARD_READ;
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const at = (projectId: string) => ({ params: Promise.resolve({ orgId, projectId }) });

beforeAll(async () => {
  const user = async (n: string) => (await prisma.user.create({ data: { email: `${n}-${stamp}@pwg.test`, displayName: n } })).id;
  [owner, admin, member, other] = [await user("owner"), await user("admin"), await user("member"), await user("other")];
  orgId = (await prisma.organization.create({ data: { name: `pwg ${stamp}`, slug: `pwg-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: admin, role: "ADMIN", permissions: "0" } });
  memberOm = (await prisma.orgMember.create({ data: { orgId, userId: member, role: "MEMBER", permissions: "0" } })).id;
  otherOm = (await prisma.orgMember.create({ data: { orgId, userId: other, role: "MEMBER", permissions: "0" } })).id;
  p1 = (await prisma.project.create({ data: { orgId, name: "One", key: `GA${K}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId, name: "Two", key: `GB${K}` } })).id;
  closed = (await prisma.project.create({ data: { orgId, name: "Closed", key: `GC${K}`, teamScopedAccess: true } })).id;
  for (const p of [p1, p2, closed]) await ensureFixtureStatuses(p);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, admin, member, other] } } }).catch(() => undefined);
});

// ─── Project settings and import ──────────────────────────────────────────

describe("editing a project", () => {
  it("a key limited to P1 can't edit P2, and P2 is unchanged", async () => {
    h.ctx = ownerKey(["items:write"], [p1]);
    expect((await putProject(json("PUT", { name: "Renamed by key" }), at(p2))).status).toBe(403);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p2 } })).name).toBe("Two");
    // Positive control: the same key edits its own project.
    expect((await putProject(json("PUT", { name: "One (key)" }), at(p1))).status).toBe(200);
  });

  it("an org-wide PROJECT_UPDATE holder can't edit a team-scoped project they can't see", async () => {
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.PROJECT_UPDATE);
    expect((await putProject(json("PUT", { name: "Renamed" }), at(closed))).status).toBe(403);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: closed } })).name).toBe("Closed");
    expect((await putProject(json("PUT", { description: "edited" }), at(p2))).status).toBe(200);
  });

  it("import: a key limited to P1 can't import into P2; it can into P1", async () => {
    h.ctx = ownerKey(["items:write"], [p1]);
    const body = { entity: "risk", mode: "validate", mapping: {}, rows: [] };
    expect((await importInto(json("POST", body), at(p2))).status).toBe(403);
    expect((await importInto(json("POST", body), at(p1))).status).toBe(200);
  });

  it("import: an org-wide PROJECT_UPDATE holder can't import into a project they can't see", async () => {
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.PROJECT_UPDATE);
    const body = { entity: "risk", mode: "validate", mapping: {}, rows: [] };
    expect((await importInto(json("POST", body), at(closed))).status).toBe(403);
    expect((await importInto(json("POST", body), at(p2))).status).toBe(200);
  });
});

// ─── Project roles ────────────────────────────────────────────────────────

describe("changing a project role through staffing", () => {
  const staffAt = (projectId: string, memberId: string) => ({ params: Promise.resolve({ orgId, projectId, memberId }) });
  const seat = async (projectId: string, orgMemberId: string, role: "MEMBER" | "MANAGER" = "MEMBER") =>
    prisma.projectMember.upsert({
      where: { projectId_orgMemberId: { projectId, orgMemberId } },
      update: { role },
      create: { projectId, orgMemberId, role },
    });

  it("an API key can't make anyone a manager, but can still edit the allocation", async () => {
    const pm = await seat(p1, otherOm);
    h.ctx = ownerKey(["items:write"]);
    expect((await patchStaff(json("PATCH", { role: "MANAGER" }), staffAt(p1, pm.id))).status).toBe(403);
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: pm.id } })).role).toBe("MEMBER");
    expect((await patchStaff(json("PATCH", { allocationPercent: 50 }), staffAt(p1, pm.id))).status).toBe(200);
  });

  it("an org-wide PROJECT_UPDATE holder who doesn't run the project can't change roles", async () => {
    const pm = await seat(p2, otherOm);
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.PROJECT_UPDATE);
    expect((await patchStaff(json("PATCH", { role: "MANAGER" }), staffAt(p2, pm.id))).status).toBe(403);
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: pm.id } })).role).toBe("MEMBER");
    expect((await patchStaff(json("PATCH", { allocationPercent: 25 }), staffAt(p2, pm.id))).status).toBe(200);
  });

  it("the project's manager and an org admin can, and the change is audited", async () => {
    const target = await seat(p1, otherOm);
    await seat(p1, memberOm, "MANAGER");
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS);
    expect((await patchStaff(json("PATCH", { role: "LEAD" }), staffAt(p1, target.id))).status).toBe(200);
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("LEAD");

    h.ctx = sessionOf(admin, "ADMIN", Permission.PROJECT_UPDATE | Permission.PROJECT_MANAGE | Permission.PROJECT_READ);
    expect((await patchStaff(json("PATCH", { role: "MANAGER" }), staffAt(p1, target.id))).status).toBe(200);
    const audit = await prisma.auditLog.findMany({ where: { orgId, entity: "project", entityId: p1, action: "project_member.set" } });
    expect(audit.map((a) => (a.metadata as { role?: string }).role).sort()).toEqual(["LEAD", "MANAGER"]);
  });
});

// ─── Boards ───────────────────────────────────────────────────────────────

describe("board structure on a project the caller can't see", () => {
  const boardIn = (projectId: string) => prisma.board.create({ data: { orgId, projectId, name: "B", type: "KANBAN" } });
  const boardAt = (projectId: string, boardId: string) => ({ params: Promise.resolve({ orgId, projectId, boardId }) });
  const cols = { columns: [{ name: "To do", key: "todo", sortOrder: 0 }] };

  it("an org-wide BOARD_UPDATE holder can't restructure its columns or add widgets", async () => {
    const b = await boardIn(closed);
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.BOARD_UPDATE);
    expect((await putColumns(json("PUT", cols), boardAt(closed, b.id))).status).toBe(404);
    expect((await addWidget(json("POST", { type: "burndown" }), boardAt(closed, b.id))).status).toBe(404);
    expect(await prisma.dashboardWidget.count({ where: { boardId: b.id } })).toBe(0);
  });

  it("the same holder can on a project they can see", async () => {
    const b = await boardIn(p2);
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.BOARD_UPDATE);
    expect((await putColumns(json("PUT", cols), boardAt(p2, b.id))).status).toBe(200);
    expect((await addWidget(json("POST", { type: "burndown" }), boardAt(p2, b.id))).status).toBe(201);
  });
});

// ─── Bulk edit and delete ─────────────────────────────────────────────────

describe("bulk delete and bulk edit hold each row to the single-item gate", () => {
  const item = (createdById: string, projectId = p1) =>
    createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById, title: "b", columnKey: "todo" });
  const exists = async (id: string) => (await prisma.workItem.count({ where: { id } })) === 1;
  /** A deny on `action` for anything the actor didn't create. */
  const notMine = (action: "ITEM_DELETE" | "ITEM_UPDATE", userId: string): AbacRule => ({
    effect: "deny", actions: [action], conditions: [{ attr: "createdById", op: "ne", value: userId }],
  });

  it("a project manager without ITEM_DELETE can't bulk delete, as they can't delete one", async () => {
    await prisma.projectMember.upsert({
      where: { projectId_orgMemberId: { projectId: p1, orgMemberId: memberOm } },
      update: { role: "MANAGER" },
      create: { projectId: p1, orgMemberId: memberOm, role: "MANAGER" },
    });
    const a = await item(member);
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS);
    expect((await bulkDelete(json("DELETE", { ids: [a.id] }), at(p1))).status).toBe(403);
    expect(await exists(a.id)).toBe(true);
    // Positive control: an admin deletes it.
    h.ctx = sessionOf(admin, "ADMIN", Permission.ITEM_DELETE | Permission.ITEM_READ | Permission.PROJECT_READ);
    expect((await bulkDelete(json("DELETE", { ids: [a.id] }), at(p1))).status).toBe(204);
    expect(await exists(a.id)).toBe(false);
  });

  it("a key limited to another project can't bulk delete here", async () => {
    const a = await item(owner);
    h.ctx = ownerKey(["read", "items:delete"], [p2]);
    expect((await bulkDelete(json("DELETE", { ids: [a.id] }), at(p1))).status).toBe(403);
    expect(await exists(a.id)).toBe(true);
    // Positive control: the same key, limited to this project.
    h.ctx = ownerKey(["read", "items:delete"], [p1]);
    expect((await bulkDelete(json("DELETE", { ids: [a.id] }), at(p1))).status).toBe(204);
    expect(await exists(a.id)).toBe(false);
  });

  it("a creator-only delete policy holds in bulk: nothing is deleted if any row is refused", async () => {
    const [mine, theirs] = [await item(member), await item(other)];
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.ITEM_DELETE, [notMine("ITEM_DELETE", member)]);
    expect((await bulkDelete(json("DELETE", { ids: [mine.id, theirs.id] }), at(p1))).status).toBe(403);
    expect([await exists(mine.id), await exists(theirs.id)]).toEqual([true, true]);
    expect((await bulkDelete(json("DELETE", { ids: [mine.id] }), at(p1))).status).toBe(204);
    expect(await exists(mine.id)).toBe(false);
  });

  it("a creator-only edit policy holds in bulk: nothing changes if any row is refused", async () => {
    const [mine, theirs] = [await item(member), await item(other)];
    h.ctx = sessionOf(member, "MEMBER", MEMBER_BITS | Permission.ITEM_BULK_EDIT, [notMine("ITEM_UPDATE", member)]);
    expect((await bulkPut(json("PUT", { ids: [mine.id, theirs.id], update: { priority: "HIGH" } }), at(p1))).status).toBe(403);
    expect(await prisma.workItem.count({ where: { id: { in: [mine.id, theirs.id] }, priority: "HIGH" } })).toBe(0);
    expect((await bulkPut(json("PUT", { ids: [mine.id], update: { priority: "HIGH" } }), at(p1))).status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: mine.id } })).priority).toBe("HIGH");
  });
});
