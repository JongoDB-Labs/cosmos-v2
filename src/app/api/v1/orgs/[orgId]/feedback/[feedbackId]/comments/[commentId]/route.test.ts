// @vitest-environment node
//
// DELETE /feedback/[feedbackId]/comments/[commentId] (COSMOS-43) against the
// REAL e2e DB. Only `getAuthContext` is mocked. Authorization mirrors the
// feedback item itself: the comment's author can delete their own; a manager
// (ORG_UPDATE) can moderate any; an unrelated member cannot.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { DELETE } from "./route";

const CONTENT_PREFIX = "[COSMOS-43-comment-del-test]";
const TITLE_PREFIX = "[COSMOS-43-comment-del-test-item]";

let orgId: string;
let aliceId: string;
let bobId: string;
let feedbackId: string;

function ctxFor(
  userId: string,
  permissions: bigint,
  orgRole: OrgRole = OrgRole.MEMBER,
): AuthContext {
  return { userId, orgId, orgRole, permissions, basePermissions: permissions, abacRules: [] };
}

function del(commentId: string, fbId = feedbackId) {
  const request = new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/feedback/${fbId}/comments/${commentId}`,
    { method: "DELETE" },
  );
  return DELETE(request, {
    params: Promise.resolve({ orgId, feedbackId: fbId, commentId }),
  });
}

/** Seed a feedback comment authored by `authorId`; returns its id. */
async function seedComment(authorId: string) {
  const row = await prisma.comment.create({
    data: {
      orgId,
      subjectType: "feedback",
      subjectId: feedbackId,
      authorId,
      content: `${CONTENT_PREFIX} ${authorId}`,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;
  aliceId = (
    await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } })
  ).id;
  bobId = (
    await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" }, select: { id: true } })
  ).id;
  feedbackId = (
    await prisma.feedbackItem.create({
      data: { orgId, authorId: aliceId, type: "FEATURE", title: `${TITLE_PREFIX} host` },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.comment.deleteMany({
    where: { orgId, subjectType: "feedback", content: { startsWith: CONTENT_PREFIX } },
  });
  await prisma.feedbackItem.deleteMany({
    where: { orgId, title: { startsWith: TITLE_PREFIX } },
  });
});

describe("DELETE /feedback/[feedbackId]/comments/[commentId]", () => {
  it("lets the author delete their own comment", async () => {
    const id = await seedComment(aliceId);
    getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(await prisma.comment.findUnique({ where: { id } })).toBeNull();
  });

  it("rejects an unrelated member deleting someone else's comment with 403", async () => {
    const id = await seedComment(aliceId);
    try {
      getAuthContext.mockResolvedValue(ctxFor(bobId, Permission.ORG_READ));
      const res = await del(id);
      expect(res.status).toBe(403);
      expect(await prisma.comment.findUnique({ where: { id } })).not.toBeNull();
    } finally {
      await prisma.comment.deleteMany({ where: { id } });
    }
  });

  it("lets a manager (ORG_UPDATE) delete any comment", async () => {
    const id = await seedComment(aliceId);
    getAuthContext.mockResolvedValue(
      ctxFor(bobId, Permission.ORG_READ | Permission.ORG_UPDATE, OrgRole.ADMIN),
    );
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(await prisma.comment.findUnique({ where: { id } })).toBeNull();
  });

  it("returns 404 when the comment belongs to a different feedback item", async () => {
    const id = await seedComment(aliceId);
    try {
      getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));
      // Right comment id, wrong (non-existent) parent item → scoped lookup misses.
      const res = await del(id, "00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(404);
      expect(await prisma.comment.findUnique({ where: { id } })).not.toBeNull();
    } finally {
      await prisma.comment.deleteMany({ where: { id } });
    }
  });
});
