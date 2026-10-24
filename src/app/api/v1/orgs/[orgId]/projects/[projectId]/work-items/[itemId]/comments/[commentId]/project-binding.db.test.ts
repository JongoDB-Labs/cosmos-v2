// @vitest-environment node
//
// The comment edit/delete route judges the project in its path (read access,
// project-manager moderation) but looked the comment up by item alone. A
// manager of project A could delete any comment on project B's items by
// putting A in the path. The comment's item must now be in the path's project.
// Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { PATCH, DELETE } from "./route";
import { PATCH as pmPatch, DELETE as pmDelete } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/pm-comments/[commentId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectA = "", projectB = "", manager = "", author = "", typeId = "";

beforeAll(async () => {
  manager = (await prisma.user.create({ data: { email: `mgr-${stamp}@cpb.test`, displayName: "Manager" } })).id;
  author = (await prisma.user.create({ data: { email: `author-${stamp}@cpb.test`, displayName: "Author" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `cpb ${stamp}`, slug: `cpb-${stamp}` } })).id;
  const managerMembership = await prisma.orgMember.create({ data: { orgId, userId: manager, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: author, role: "MEMBER", permissions: "0" } });
  projectA = (await prisma.project.create({ data: { orgId, name: "A", key: `PA${stamp.slice(0, 3).toUpperCase()}` } })).id;
  projectB = (await prisma.project.create({ data: { orgId, name: "B", key: `PB${stamp.slice(0, 3).toUpperCase()}` } })).id;
  // The manager runs A only.
  await prisma.projectMember.create({ data: { projectId: projectA, orgMemberId: managerMembership.id, role: "MANAGER" } });
  await ensureFixtureStatuses(projectA);
  await ensureFixtureStatuses(projectB);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [manager, author] } } }).catch(() => undefined);
});

/** An ordinary member's session: reads projects and comments, nothing org-wide. */
const member = (userId: string): AuthContext => ({
  userId, orgId, orgRole: "MEMBER", abacRules: [], basePermissions: 0n,
  permissions: Permission.PROJECT_READ | Permission.ITEM_READ | Permission.COMMENT_READ,
});
const commentOn = async (projectId: string) => {
  const item = await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: author, title: "t", columnKey: "todo" });
  const comment = await prisma.comment.create({ data: { orgId, workItemId: item.id, authorId: author, content: "original" } });
  return { itemId: item.id, commentId: comment.id };
};
const at = (projectId: string, ids: { itemId: string; commentId: string }) => ({ params: Promise.resolve({ orgId, projectId, ...ids }) });
const patch = (content: string) => new NextRequest("http://localhost/x", { method: "PATCH", body: JSON.stringify({ content }), headers: { "Content-Type": "application/json" } });
const del = () => new NextRequest("http://localhost/x", { method: "DELETE" });

describe("a comment is reached only through its own item's project", () => {
  it("A's manager can't delete a comment on a B item by naming A in the path", async () => {
    const ids = await commentOn(projectB);
    h.ctx = member(manager);
    expect((await DELETE(del(), at(projectA, ids))).status).toBe(404);
    expect(await prisma.comment.count({ where: { id: ids.commentId } })).toBe(1);
  });

  it("the author can't edit through another project's path either", async () => {
    const ids = await commentOn(projectB);
    h.ctx = member(author);
    expect((await PATCH(patch("changed"), at(projectA, ids))).status).toBe(404);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: ids.commentId } })).content).toBe("original");
  });

  it("through the right project, moderation and editing work as before", async () => {
    const onA = await commentOn(projectA);
    h.ctx = member(manager);
    expect((await DELETE(del(), at(projectA, onA))).status).toBe(204);
    const onB = await commentOn(projectB);
    h.ctx = member(author);
    expect((await PATCH(patch("changed"), at(projectB, onB))).status).toBe(200);
  });
});

describe("a register comment is reached only through its subject's project", () => {
  // A comment on the project itself (subjectType "project"), the simplest subject.
  const projectComment = async (projectId: string) =>
    (await prisma.comment.create({ data: { orgId, subjectType: "project", subjectId: projectId, authorId: author, content: "original" } })).id;
  const pmAt = (projectId: string, commentId: string) => ({ params: Promise.resolve({ orgId, projectId, commentId }) });

  it("A's manager can't delete a comment on project B by naming A in the path", async () => {
    const id = await projectComment(projectB);
    h.ctx = member(manager);
    expect((await pmDelete(del(), pmAt(projectA, id))).status).toBe(404);
    expect(await prisma.comment.count({ where: { id } })).toBe(1);
  });

  it("the author can't edit through another project's path", async () => {
    const id = await projectComment(projectB);
    h.ctx = member(author);
    expect((await pmPatch(patch("changed"), pmAt(projectA, id))).status).toBe(404);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id } })).content).toBe("original");
  });

  it("through the right project, moderation and editing work as before", async () => {
    const onA = await projectComment(projectA);
    h.ctx = member(manager);
    expect((await pmDelete(del(), pmAt(projectA, onA))).status).toBe(200);
    const onB = await projectComment(projectB);
    h.ctx = member(author);
    expect((await pmPatch(patch("changed"), pmAt(projectB, onB))).status).toBe(200);
  });
});
