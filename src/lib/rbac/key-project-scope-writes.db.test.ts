// @vitest-environment node
//
// A project-scoped API key acts only in its projects. Reads always held to
// that (getReadableProjectIds, isProjectVisible), but most writes didn't: their
// gates (requireAccess, requireProjectManage, canManageProject) checked bits and
// roles, never the key's `projectScope`. An OWNER's key limited to P1 could
// create work items in P2, delete them one at a time or in bulk, and add P2
// milestones. The gates now ask `inKeyProjectScope` first. Against a real
// database, through the real routes.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { DELETE as deleteItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { DELETE as bulkDelete } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";
import { DELETE as deleteItemById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route";
import { POST as createMilestone } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/route";
import { readableDocument } from "@/lib/files/access";
import { POST as createInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/route";
import { POST as addComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route";
import { DELETE as deleteDocument } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/[docId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", p1 = "", p2 = "", owner = "", typeId = "";

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@key-scope.test`, displayName: "Owner" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ks ${stamp}`, slug: `ks-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId, name: "One", key: `KA${stamp.slice(0, 3).toUpperCase()}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId, name: "Two", key: `KB${stamp.slice(0, 3).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(p1);
  await ensureFixtureStatuses(p2);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner } }).catch(() => undefined);
});

/** The OWNER's key with these scopes, limited to `projects` (or org-wide). */
const key = (scopes: string[], projects?: string[]): AuthContext => ({
  userId: owner, orgId, orgRole: "OWNER", abacRules: [],
  permissions: scopeMask(scopes), basePermissions: scopeMask(scopes),
  isApiKey: true, scopes, ...(projects && { projectScope: projects }),
});
const session = (): AuthContext => ({ userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] });
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
const item = (projectId: string) =>
  createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title: "t", columnKey: "todo" });
const exists = async (id: string) => !!(await prisma.workItem.findUnique({ where: { id } }));

const WRITER = ["items:write", "items:delete"];
const P1_KEY = () => key(WRITER, [p1]);

describe("a key limited to P1 can't write in P2", () => {
  it("create: refused, and nothing is created", async () => {
    h.ctx = P1_KEY();
    const res = await createItem(json("POST", { title: "x", columnKey: "todo", workItemTypeId: typeId }), { params: Promise.resolve({ orgId, projectId: p2 }) });
    expect(res.status).toBe(403);
    expect(await prisma.workItem.count({ where: { projectId: p2, title: "x" } })).toBe(0);
  });

  it("delete, by project path and by id: refused, and the item stays", async () => {
    h.ctx = P1_KEY();
    const a = await item(p2);
    expect((await deleteItem(json("DELETE"), { params: Promise.resolve({ orgId, projectId: p2, itemId: a.id }) })).status).toBe(403);
    expect((await deleteItemById(json("DELETE"), { params: Promise.resolve({ orgId, itemId: a.id }) })).status).toBe(403);
    expect(await exists(a.id)).toBe(true);
  });

  it("bulk delete: refused, and the items stay", async () => {
    h.ctx = P1_KEY();
    const a = await item(p2);
    expect((await bulkDelete(json("DELETE", { ids: [a.id] }), { params: Promise.resolve({ orgId, projectId: p2 }) })).status).toBe(403);
    expect(await exists(a.id)).toBe(true);
  });

  it("a milestone (planning:write, a manager gate): refused, and nothing is created", async () => {
    h.ctx = key(["planning:write"], [p1]);
    const res = await createMilestone(json("POST", { title: "M", dueDate: "2026-12-01T00:00:00.000Z" }), { params: Promise.resolve({ orgId, projectId: p2 }) });
    expect(res.status).toBe(403);
    expect(await prisma.milestone.count({ where: { projectId: p2 } })).toBe(0);
  });
});

describe("beyond work items", () => {
  const sprint = (name: string) => ({ name, startDate: "2026-11-02T00:00:00.000Z", endDate: "2026-11-13T00:00:00.000Z" });

  it("a sprint (planning:write): refused in P2, created in P1", async () => {
    h.ctx = key(["planning:write"], [p1]);
    expect((await createInterval(json("POST", sprint("S2")), { params: Promise.resolve({ orgId, projectId: p2 }) })).status).toBe(403);
    expect(await prisma.interval.count({ where: { projectId: p2 } })).toBe(0);
    expect((await createInterval(json("POST", sprint("S1")), { params: Promise.resolve({ orgId, projectId: p1 }) })).status).toBe(201);
  });

  it("a comment (items:write): refused on a P2 item, posted on a P1 item", async () => {
    h.ctx = P1_KEY();
    const a = await item(p2);
    const b = await item(p1);
    expect((await addComment(json("POST", { content: "hi" }), { params: Promise.resolve({ orgId, projectId: p2, itemId: a.id }) })).status).toBeGreaterThanOrEqual(403);
    expect(await prisma.comment.count({ where: { workItemId: a.id } })).toBe(0);
    expect((await addComment(json("POST", { content: "hi" }), { params: Promise.resolve({ orgId, projectId: p1, itemId: b.id }) })).status).toBe(201);
  });

  it("a file the key's minter uploaded: not deletable in P2, deletable in P1", async () => {
    h.ctx = P1_KEY();
    const file = (projectId: string) => prisma.document.create({
      data: { orgId, projectId, title: "f", storageKey: `k-${projectId}-${Math.random()}`, filename: "f.txt", contentType: "text/plain", size: 1, uploadedById: owner },
    });
    const inP2 = await file(p2);
    expect((await deleteDocument(json("DELETE"), { params: Promise.resolve({ orgId, projectId: p2, docId: inP2.id }) })).status).toBe(404);
    expect(await prisma.document.count({ where: { id: inP2.id } })).toBe(1);
    const inP1 = await file(p1);
    expect((await deleteDocument(json("DELETE"), { params: Promise.resolve({ orgId, projectId: p1, docId: inP1.id }) })).status).toBeLessThan(300);
  });
});

describe("files", () => {
  it("a restricted P2 file the key's minter uploaded is out of a P1 key's reach, and in reach of an org-wide key", async () => {
    const doc = await prisma.document.create({
      data: { orgId, projectId: p2, visibility: "RESTRICTED", title: "f", storageKey: `k-${stamp}`, filename: "f.txt", contentType: "text/plain", size: 1, uploadedById: owner },
    });
    expect(await readableDocument(orgId, doc.id, P1_KEY())).toBeNull();
    expect(await readableDocument(orgId, doc.id, key(WRITER))).not.toBeNull();
  });
});

describe("what was allowed still is", () => {
  it("the P1 key writes in P1", async () => {
    h.ctx = P1_KEY();
    expect((await createItem(json("POST", { title: "in scope", columnKey: "todo", workItemTypeId: typeId }), { params: Promise.resolve({ orgId, projectId: p1 }) })).status).toBe(201);
    const a = await item(p1);
    expect((await deleteItem(json("DELETE"), { params: Promise.resolve({ orgId, projectId: p1, itemId: a.id }) })).status).toBe(204);
    const b = await item(p1);
    expect((await bulkDelete(json("DELETE", { ids: [b.id] }), { params: Promise.resolve({ orgId, projectId: p1 }) })).status).toBe(204);
    h.ctx = key(["planning:write"], [p1]);
    expect((await createMilestone(json("POST", { title: "M1", dueDate: "2026-12-01T00:00:00.000Z" }), { params: Promise.resolve({ orgId, projectId: p1 }) })).status).toBe(200);
  });

  it("an org-wide key and a browser session write in P2", async () => {
    for (const ctx of [key(WRITER), session()]) {
      h.ctx = ctx;
      expect((await createItem(json("POST", { title: "any", columnKey: "todo", workItemTypeId: typeId }), { params: Promise.resolve({ orgId, projectId: p2 }) })).status).toBe(201);
      const a = await item(p2);
      expect((await deleteItemById(json("DELETE"), { params: Promise.resolve({ orgId, itemId: a.id }) })).status).toBe(204);
      expect(await exists(a.id)).toBe(false);
    }
  });
});
