// @vitest-environment node
//
// The actions on one work item on their public contracts (PR3c-2b): comments
// (both paths, edit, delete), watching, duplicate, merge and split. Against a
// real database, through the real routes, so every response passes the strict
// contract projection with a real row behind it.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { Comment, WorkItemComment } from "@/lib/openapi/schemas/work-items";
import { MergeResult, SplitResult, WorkItemDuplicate } from "@/lib/openapi/schemas/work-item-actions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as comment } from "./comments/route";
import { PATCH as editComment, DELETE as deleteComment } from "./comments/[commentId]/route";
import { POST as commentById } from "../../../../work-items/[itemId]/comments/route";
import { GET as getWatch, POST as watch, DELETE as unwatch } from "./watch/route";
import { POST as duplicate } from "./duplicate/route";
import { POST as merge } from "./merge/route";
import { POST as split } from "./split-assignees/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", owner = "", other = "", typeId = "";

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@ac.test`, displayName: "Owner" } })).id;
  other = (await prisma.user.create({ data: { email: `other-${stamp}@ac.test`, displayName: "Other" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ac ${stamp}`, slug: `ac-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: other, role: "MEMBER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "A", key: `AC${stamp.slice(0, 3).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } }).catch(() => undefined);
});

const session = (): AuthContext => ({ userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] });
const key = (scopes: string[]): AuthContext => ({
  ...session(), permissions: scopeMask(scopes), basePermissions: scopeMask(scopes), isApiKey: true, scopes,
});
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const onItem = (itemId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId }) });
const byId = (itemId: string) => ({ params: Promise.resolve({ orgId, itemId }) });
const onComment = (itemId: string, commentId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId, commentId }) });
const item = (title = "t") => createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title, columnKey: "todo" });
const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

describe("comments", () => {
  it("an items:write key comments on both paths, and the answer names the key's owner as the author", async () => {
    // A key has no session user: the author used to come back nameless.
    h.ctx = key(["items:write"]);
    const a = await item();
    for (const call of [() => comment(req("POST", { content: "hello" }), onItem(a.id)), () => commentById(req("POST", { content: "again" }), byId(a.id))]) {
      const res = await call();
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(keysOf(WorkItemComment));
      expect(body).toMatchObject({ authorId: owner, authorName: "Owner", canEdit: true, canDelete: true });
    }
    expect(await prisma.comment.count({ where: { workItemId: a.id } })).toBe(2);
  });

  it("a read key can't comment; an empty or oversized comment is a 400", async () => {
    const a = await item();
    h.ctx = key(["read"]);
    const refused = await comment(req("POST", { content: "x" }), onItem(a.id));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("insufficient_scope");
    h.ctx = session();
    expect((await comment(req("POST", { content: "" }), onItem(a.id))).status).toBe(400);
    expect((await comment(req("POST", { content: "x".repeat(10_001) }), onItem(a.id))).status).toBe(400);
  });

  it("by id, an unknown item is a 404", async () => {
    h.ctx = session();
    expect((await commentById(req("POST", { content: "x" }), byId("9f8e7d6c-5b4a-4321-8fed-cba987654321"))).status).toBe(404);
  });

  it("the author edits it (the documented comment) and deletes it (204)", async () => {
    h.ctx = session();
    const a = await item();
    const c = await prisma.comment.create({ data: { orgId, workItemId: a.id, authorId: owner, content: "first" } });
    const res = await editComment(req("PATCH", { content: "second" }), onComment(a.id, c.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(keysOf(Comment));
    expect(body.content).toBe("second");
    expect((await deleteComment(req("DELETE"), onComment(a.id, c.id))).status).toBe(204);
    expect(await prisma.comment.count({ where: { id: c.id } })).toBe(0);
  });

  it("someone else's comment can't be edited: a problem+json 403", async () => {
    h.ctx = session();
    const a = await item();
    const c = await prisma.comment.create({ data: { orgId, workItemId: a.id, authorId: other, content: "theirs" } });
    const res = await editComment(req("PATCH", { content: "mine now" }), onComment(a.id, c.id));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).content).toBe("theirs");
  });
});

describe("watching", () => {
  it("watch, read it back, unwatch; a read key may watch, as it always could", async () => {
    const a = await item();
    h.ctx = key(["read"]);
    expect(await (await getWatch(req("GET"), onItem(a.id))).json()).toEqual({ watching: false, watcherCount: 0 });
    expect(await (await watch(req("POST"), onItem(a.id))).json()).toEqual({ watching: true });
    expect(await (await watch(req("POST"), onItem(a.id))).json()).toEqual({ watching: true });
    expect(await (await getWatch(req("GET"), onItem(a.id))).json()).toEqual({ watching: true, watcherCount: 1 });
    expect(await (await unwatch(req("DELETE"), onItem(a.id))).json()).toEqual({ watching: false });
    expect(await prisma.workItemWatcher.count({ where: { workItemId: a.id } })).toBe(0);
  });
});

describe("duplicate", () => {
  it("with no body at all (the table's action) it answers 201 with exactly the documented copy", async () => {
    h.ctx = session();
    const a = await item("Original");
    const res = await duplicate(new NextRequest("http://localhost/x", { method: "POST" }), onItem(a.id));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(keysOf(WorkItemDuplicate));
    expect(body).toMatchObject({ title: "Copy of Original", children: [] });
  });

  it("withChildren copies the sub-items under the copy; a body that isn't JSON is a 400", async () => {
    h.ctx = session();
    const parent = await item("Parent");
    const child = await item("Child");
    await prisma.workItem.update({ where: { id: child.id }, data: { parentId: parent.id } });
    const res = await duplicate(req("POST", { withChildren: true }), onItem(parent.id));
    expect(res.status).toBe(201);
    expect((await res.json()).children.map((c: { title: string }) => c.title)).toEqual(["Child"]);
    const bad = new NextRequest("http://localhost/x", { method: "POST", body: "{nope", headers: { "Content-Type": "application/json" } });
    expect((await duplicate(bad, onItem(parent.id))).status).toBe(400);
  });
});

describe("merge", () => {
  it("answers both items and what moved; merging an item into itself is a problem+json 400", async () => {
    h.ctx = session();
    const [dup, survivor] = [await item("Dup"), await item("Survivor")];
    await prisma.comment.create({ data: { orgId, workItemId: dup.id, authorId: owner, content: "moves" } });
    const res = await merge(req("POST", { intoId: survivor.id }), onItem(dup.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(keysOf(MergeResult));
    expect(body.merged.id).toBe(dup.id);
    expect(body.into.id).toBe(survivor.id);
    expect(body.moved.comments).toBe(1);
    const self = await item("Self");
    const refused = await merge(req("POST", { intoId: self.id }), onItem(self.id));
    expect(refused.status).toBe(400);
    expect(res.headers.get("content-type")).not.toContain("problem");
    expect(refused.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("split per assignee", () => {
  it("keeps the first assignee and copies the item for the other; one assignee is a 400", async () => {
    h.ctx = session();
    const a = await item("Shared");
    await prisma.workItem.update({ where: { id: a.id }, data: { assigneeId: owner } });
    await prisma.workItemAssignee.createMany({ data: [{ workItemId: a.id, userId: owner, sortOrder: 0 }, { workItemId: a.id, userId: other, sortOrder: 1 }] });
    const res = await split(req("POST"), onItem(a.id));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(keysOf(SplitResult));
    expect(body.keptAssigneeId).toBe(owner);
    expect(body.copies).toMatchObject([{ title: "Shared", assigneeId: other }]);

    const solo = await item("Solo");
    await prisma.workItemAssignee.create({ data: { workItemId: solo.id, userId: owner, sortOrder: 0 } });
    expect((await split(req("POST"), onItem(solo.id))).status).toBe(400);
  });
});
