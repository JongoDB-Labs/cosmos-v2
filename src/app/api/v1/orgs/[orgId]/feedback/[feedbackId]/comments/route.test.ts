// @vitest-environment node
//
// GET/POST /feedback/[feedbackId]/comments (COSMOS-43), against the REAL e2e DB
// (seeded `test-org` with users alice@test.local + bob@test.local). Only
// `getAuthContext` is mocked — session cookies aren't available in a
// route-handler test — so the caller's permissions are whatever we hand it;
// `@/lib/db/client` is left unmocked so real Comment/FeedbackItem rows are
// written and read.
//
// Feature under test: any org member can comment on a feature/bug request, and
// every member viewing the same item sees those comments (the "not wired up"
// gap the ticket closes). Comments reuse the polymorphic Comment model
// (subjectType "feedback") — no new table.
//
// Every row a test creates is deleted in a `finally`/`afterAll`, so a failed
// assertion never leaves the shared e2e DB dirty for the next run.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { GET, POST } from "./route";

const CONTENT_PREFIX = "[COSMOS-43-comment-test]";
const TITLE_PREFIX = "[COSMOS-43-comment-test-item]";

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

function get(fbId: string) {
  const request = new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/feedback/${fbId}/comments`,
  );
  return GET(request, { params: Promise.resolve({ orgId, feedbackId: fbId }) });
}

function post(fbId: string, body: unknown) {
  const request = new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/feedback/${fbId}/comments`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return POST(request, { params: Promise.resolve({ orgId, feedbackId: fbId }) });
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;

  const alice = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  aliceId = alice.id;

  const bob = await prisma.user.findFirstOrThrow({
    where: { email: "bob@test.local" },
    select: { id: true },
  });
  bobId = bob.id;

  const item = await prisma.feedbackItem.create({
    data: { orgId, authorId: aliceId, type: "FEATURE", title: `${TITLE_PREFIX} host` },
    select: { id: true },
  });
  feedbackId = item.id;
});

afterAll(async () => {
  await prisma.comment.deleteMany({
    where: { orgId, subjectType: "feedback", content: { startsWith: CONTENT_PREFIX } },
  });
  await prisma.feedbackItem.deleteMany({
    where: { orgId, title: { startsWith: TITLE_PREFIX } },
  });
});

describe("POST + GET /feedback/[feedbackId]/comments", () => {
  it("lets a member post a comment that other members can then read", async () => {
    getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));
    const body = `${CONTENT_PREFIX} please add dark mode`;
    const res = await post(feedbackId, { content: body });
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.content).toBe(body);
    expect(saved.authorId).toBe(aliceId);
    expect(saved.canDelete).toBe(true); // author owns it

    // Bob (a different member) sees Alice's comment on the same item.
    getAuthContext.mockResolvedValue(ctxFor(bobId, Permission.ORG_READ));
    const listRes = await get(feedbackId);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    const mine = list.find((c: { id: string }) => c.id === saved.id);
    expect(mine).toBeTruthy();
    expect(mine.content).toBe(body);
    // A plain member who didn't author it and can't manage the org can't delete it.
    expect(mine.canDelete).toBe(false);
  });

  it("lets a manager (ORG_UPDATE) delete-flag any comment", async () => {
    getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));
    const created = await (
      await post(feedbackId, { content: `${CONTENT_PREFIX} manager view` })
    ).json();

    getAuthContext.mockResolvedValue(
      ctxFor(bobId, Permission.ORG_READ | Permission.ORG_UPDATE, OrgRole.ADMIN),
    );
    const list = await (await get(feedbackId)).json();
    const row = list.find((c: { id: string }) => c.id === created.id);
    expect(row.canDelete).toBe(true); // manager can moderate
  });

  it("rejects an empty/whitespace comment with 400", async () => {
    getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));
    const res = await post(feedbackId, { content: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await post(feedbackId, { content: `${CONTENT_PREFIX} nope` });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a feedback item that doesn't exist", async () => {
    getAuthContext.mockResolvedValue(ctxFor(aliceId, Permission.ORG_READ));
    const res = await post(
      "00000000-0000-0000-0000-000000000000",
      { content: `${CONTENT_PREFIX} ghost` },
    );
    expect(res.status).toBe(404);
  });
});
