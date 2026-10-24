// @vitest-environment node
//
// The work-item writes on their public contracts (PR3c-2a): create, update
// (project path, and PATCH/PUT by id), delete (both paths) and bulk. Against a
// real database, through the real routes, so every response passes the strict
// contract projection with a real row behind it.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { WorkItemCreated, WorkItemUpdated } from "@/lib/openapi/schemas/work-item-write";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as create } from "./route";
import { PUT as update, DELETE as remove } from "./[itemId]/route";
import { PUT as bulkUpdate, DELETE as bulkDelete } from "./bulk/route";
import { PATCH as patchById, PUT as putById, DELETE as deleteById } from "../../../work-items/[itemId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
const NO_SUCH_ITEM = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
let orgId = "", projectId = "", owner = "", typeId = "";

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@wc.test`, displayName: "Owner" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `wc ${stamp}`, slug: `wc-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "W", key: `WC${stamp.slice(0, 3).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: owner } }).catch(() => undefined);
});

const session = (): AuthContext => ({ userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] });
const key = (scopes: string[]): AuthContext => ({
  ...session(), permissions: scopeMask(scopes), basePermissions: scopeMask(scopes), isApiKey: true, scopes,
});
const req = (method: string, body?: unknown, raw?: string) =>
  new NextRequest("http://localhost/x", {
    method,
    ...((body !== undefined || raw !== undefined) && { body: raw ?? JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const inProject = () => ({ params: Promise.resolve({ orgId, projectId }) });
const onItem = (itemId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId }) });
const byId = (itemId: string) => ({ params: Promise.resolve({ orgId, itemId }) });
const item = () => createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title: "t", columnKey: "todo" });
const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

describe("create", () => {
  it("answers 201 with exactly the documented item, no search index", async () => {
    h.ctx = session();
    const res = await create(req("POST", { title: "New", columnKey: "todo", workItemTypeId: typeId, tags: ["x"] }), inProject());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(keysOf(WorkItemCreated));
    expect(body).toMatchObject({ title: "New", tags: ["x"], priority: "MEDIUM" });
  });

  it("a body that isn't valid is a problem+json 400 that names the field; bad JSON is a 400 too", async () => {
    h.ctx = session();
    const res = await create(req("POST", { columnKey: "todo" }), inProject());
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await res.json()).issues.map((i: { path: string[] }) => i.path[0])).toContain("title");
    expect((await create(req("POST", undefined, "{nope"), inProject())).status).toBe(400);
  });
});

describe("update", () => {
  it("the project path, PATCH by id and PUT by id answer the same documented item", async () => {
    h.ctx = session();
    const a = await item();
    const bodies = [];
    for (const [call, ctx] of [[update, onItem(a.id)], [patchById, byId(a.id)], [putById, byId(a.id)]] as const) {
      const res = await call(req("PUT", { priority: "HIGH" }), ctx as never);
      expect(res.status).toBe(200);
      bodies.push(await res.json());
    }
    for (const b of bodies) {
      expect(Object.keys(b).sort()).toEqual(keysOf(WorkItemUpdated));
      expect(b).toMatchObject({ id: a.id, priority: "HIGH", scheduleCascade: [] });
    }
  });

  it("by id: an unauthenticated caller gets 401 whether or not the item exists; a signed-in one gets 404 for an unknown id", async () => {
    const a = await item();
    h.ctx = null;
    expect((await patchById(req("PATCH", { title: "x" }), byId(a.id))).status).toBe(401);
    expect((await patchById(req("PATCH", { title: "x" }), byId(NO_SUCH_ITEM))).status).toBe(401);
    h.ctx = session();
    const res = await patchById(req("PATCH", { title: "x" }), byId(NO_SUCH_ITEM));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

describe("delete", () => {
  it("both paths answer 204 and the item is gone; an unknown id is a 404", async () => {
    h.ctx = session();
    const a = await item();
    const b = await item();
    expect((await remove(req("DELETE"), onItem(a.id))).status).toBe(204);
    expect((await deleteById(req("DELETE"), byId(b.id))).status).toBe(204);
    expect(await prisma.workItem.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
    expect((await deleteById(req("DELETE"), byId(NO_SUCH_ITEM))).status).toBe(404);
  });
});

describe("bulk", () => {
  it("update answers {updated, denied}; delete answers 204; an empty selection is a 400", async () => {
    h.ctx = session();
    const [a, b] = [await item(), await item()];
    const res = await bulkUpdate(req("PUT", { ids: [a.id, b.id], update: { priority: "LOW" } }), inProject());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2, denied: [] });
    expect((await bulkDelete(req("DELETE", { ids: [a.id, b.id] }), inProject())).status).toBe(204);
    expect(await prisma.workItem.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
    expect((await bulkDelete(req("DELETE", { ids: [] }), inProject())).status).toBe(400);
  });
});

describe("API key scopes", () => {
  it("a read key can't create, update or delete; an items:write key can't delete", async () => {
    const a = await item();
    for (const [scopes, calls] of [
      [["read"], [() => create(req("POST", { title: "k", columnKey: "todo" }), inProject()), () => update(req("PUT", { title: "k" }), onItem(a.id)), () => remove(req("DELETE"), onItem(a.id))]],
      [["items:write"], [() => remove(req("DELETE"), onItem(a.id)), () => deleteById(req("DELETE"), byId(a.id)), () => bulkDelete(req("DELETE", { ids: [a.id] }), inProject())]],
    ] as const) {
      h.ctx = key([...scopes]);
      for (const call of calls) {
        const res = await call();
        expect(res.status, scopes.join()).toBe(403);
        expect((await res.json()).code).toBe("insufficient_scope");
      }
    }
    expect(await prisma.workItem.count({ where: { id: a.id } })).toBe(1);
  });
});
