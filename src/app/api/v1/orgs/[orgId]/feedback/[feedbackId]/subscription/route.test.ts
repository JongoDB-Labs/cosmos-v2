// @vitest-environment node
//
// Feedback discussion, Phase 2: who follows an item, and who hears about a new
// comment. Against the REAL e2e DB (test-org: alice ADMIN, bob and carol
// MEMBER). Only getAuthContext is mocked.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { GET, PUT } from "./route";
import { POST as CREATE_ITEM } from "../../route";
import { POST as VOTE } from "../vote/route";
import { POST as COMMENT } from "../comments/route";
import { PATCH as EDIT } from "../comments/[commentId]/route";

const PREFIX = "[fb-follow-test]";
let orgId: string;
let alice: string;
let bob: string;
let carol: string;
let itemId: string;

function as(userId: string, role: keyof typeof RolePermissions) {
  getAuthContext.mockResolvedValue({
    userId,
    orgId,
    orgRole: role,
    permissions: RolePermissions[role],
    basePermissions: RolePermissions[role],
    abacRules: [],
  });
}
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
const p = (extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ orgId, feedbackId: itemId, ...extra }) }) as never;
async function body(res: Response) {
  const j = await res.json();
  return j.data ?? j;
}
const reasonOf = async (userId: string) =>
  (
    await prisma.feedbackSubscription.findUnique({
      where: { feedbackItemId_userId: { feedbackItemId: itemId, userId } },
    })
  )?.reason;
const commentNotices = (userId: string) =>
  prisma.notification.findMany({ where: { orgId, userId, refId: itemId, type: { startsWith: "feedback.comment." } } });

beforeAll(async () => {
  orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } })).id;
  const users = await prisma.user.findMany({
    where: { email: { in: ["alice@test.local", "bob@test.local", "carol@test.local"] } },
    select: { id: true, email: true },
  });
  const id = (e: string) => users.find((u) => u.email === e)!.id;
  alice = id("alice@test.local");
  bob = id("bob@test.local");
  carol = id("carol@test.local");
});

afterAll(async () => {
  const items = await prisma.feedbackItem.findMany({ where: { orgId, title: { startsWith: PREFIX } }, select: { id: true } });
  const ids = items.map((i) => i.id);
  await prisma.comment.deleteMany({ where: { orgId, subjectType: "feedback", subjectId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { orgId, refId: { in: ids } } });
  await prisma.feedbackItem.deleteMany({ where: { id: { in: ids } } });
});

describe("following a feedback item (e2e DB)", () => {
  it("subscribes the author when they file it", async () => {
    as(bob, "MEMBER");
    const res = await CREATE_ITEM(
      req("POST", { type: "FEATURE", title: `${PREFIX} offline mode`, description: "please" }),
      { params: Promise.resolve({ orgId }) } as never,
    );
    expect(res.status).toBe(200);
    itemId = (await body(res)).id;
    expect(await reasonOf(bob)).toBe("author");
    expect((await body(await GET(req("GET"), p()))).following).toBe(true);
  });

  it("subscribes a voter, and a commenter", async () => {
    as(carol, "MEMBER");
    expect((await VOTE(req("POST"), p())).status).toBeLessThan(300);
    expect(await reasonOf(carol)).toBe("voter");
    as(alice, "ADMIN");
    expect((await COMMENT(req("POST", { content: "We'll look at it." }), p())).status).toBe(201);
    expect(await reasonOf(alice)).toBe("commenter");
  });

  it("tells every follower about a new comment, once, and never the writer", async () => {
    await prisma.notification.deleteMany({ where: { orgId, refId: itemId } });
    as(carol, "MEMBER");
    const res = await COMMENT(req("POST", { content: `Same here <@${bob}>` }), p());
    expect(res.status).toBe(201);
    // bob: mentioned (one notice, not two); alice: follower; carol: the writer.
    expect((await commentNotices(bob)).map((n) => n.type)).toEqual(["feedback.comment.mentioned"]);
    expect((await commentNotices(alice)).map((n) => n.type)).toEqual(["feedback.comment.created"]);
    expect(await commentNotices(carol)).toHaveLength(0);

    // An edit is not news to followers: one that adds a mention tells only the
    // newly mentioned person (alice), not the other followers (bob).
    await prisma.notification.deleteMany({ where: { orgId, refId: itemId } });
    const id = (await body(res)).id;
    const edited = await EDIT(req("PATCH", { content: `Same here <@${bob}> <@${alice}>` }), p({ commentId: id }));
    expect(edited.status).toBe(200);
    expect((await commentNotices(alice)).map((n) => n.type)).toEqual(["feedback.comment.mentioned"]);
    expect(await commentNotices(bob)).toHaveLength(0);
  });

  it("stops after unfollowing, and voting or commenting again does not undo it", async () => {
    as(bob, "MEMBER");
    expect((await body(await PUT(req("PUT", { following: false }), p()))).following).toBe(false);
    expect((await COMMENT(req("POST", { content: "Still want it" }), p())).status).toBe(201);
    expect((await body(await GET(req("GET"), p()))).following).toBe(false);

    await prisma.notification.deleteMany({ where: { orgId, refId: itemId } });
    as(alice, "ADMIN");
    expect((await COMMENT(req("POST", { content: "Update soon." }), p())).status).toBe(201);
    expect(await commentNotices(bob)).toHaveLength(0);
    expect(await commentNotices(carol)).toHaveLength(1);

    as(bob, "MEMBER");
    expect((await body(await PUT(req("PUT", { following: true }), p()))).following).toBe(true);
    expect((await body(await GET(req("GET"), p()))).following).toBe(true);
  });
});
