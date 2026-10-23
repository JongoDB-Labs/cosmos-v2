// @vitest-environment node
//
// Feedback discussion, Phase 1, against the REAL e2e DB (seeded test-org with
// alice = ADMIN, bob and carol = MEMBER). Only getAuthContext is mocked, so
// every query, count and cascade runs for real. Rows are torn down afterwards.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[commentId]/route";
import { GET as REVISIONS } from "./[commentId]/revisions/route";
import { DELETE as DELETE_ITEM, PUT as PUT_ITEM } from "../route";
import { GET as LIST } from "../../route";
import { setFeedbackStatus } from "@/lib/ai/executors/feedback";
import { memberToolCtx } from "@/lib/testing/tool-auth";

const PREFIX = "[fb-discussion-test]";
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

const p = (extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ orgId, feedbackId: itemId, ...extra }) }) as never;
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
async function body(res: Response) {
  const j = await res.json();
  return j.data ?? j;
}
async function post(content: string, parentId?: string) {
  return POST(req("POST", { content, ...(parentId ? { parentId } : {}) }), p());
}
async function thread() {
  return body(await GET(req("GET"), p()));
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" }, select: { id: true } });
  orgId = org.id;
  const users = await prisma.user.findMany({
    where: { email: { in: ["alice@test.local", "bob@test.local", "carol@test.local"] } },
    select: { id: true, email: true },
  });
  const id = (e: string) => users.find((u) => u.email === e)!.id;
  alice = id("alice@test.local");
  bob = id("bob@test.local");
  carol = id("carol@test.local");
  const item = await prisma.feedbackItem.create({
    data: { orgId, authorId: bob, type: "FEATURE", title: `${PREFIX} dark mode` },
  });
  itemId = item.id;
});

afterAll(async () => {
  const items = await prisma.feedbackItem.findMany({ where: { orgId, title: { startsWith: PREFIX } }, select: { id: true } });
  const ids = items.map((i) => i.id);
  await prisma.comment.deleteMany({ where: { orgId, subjectType: "feedback", subjectId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { orgId, refId: { in: ids } } });
  await prisma.feedbackItem.deleteMany({ where: { id: { in: ids } } });
});

describe("feedback discussion (e2e DB)", () => {
  let top: string;

  it("lets a member comment and counts it", async () => {
    as(carol, "MEMBER");
    const res = await post("Would love this for night shifts.");
    expect(res.status).toBe(201);
    const c = await body(res);
    top = c.id;
    expect(c).toMatchObject({ content: "Would love this for night shifts.", canEdit: true, deleted: false });
    expect(c.author.displayName).toBe("Carol");

    const item = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.commentCount).toBe(1);
    expect(item.lastActivityAt).not.toBeNull();
  });

  it("keeps replies one level deep: a reply to a reply joins the same thread", async () => {
    as(bob, "MEMBER");
    const r1 = await body(await post("Same here.", top));
    as(alice, "ADMIN");
    const r2 = await body(await post("Noted, thanks both.", r1.id));
    expect(r1.parentId).toBe(top);
    expect(r2.parentId).toBe(top);

    const t = await thread();
    expect(t).toHaveLength(1);
    expect(t[0].replies.map((r: { content: string }) => r.content)).toEqual(["Same here.", "Noted, thanks both."]);
  });

  it("notifies the person replied to", async () => {
    const n = await prisma.notification.findFirst({
      where: { orgId, userId: carol, type: "feedback.comment.replied", refId: itemId },
    });
    expect(n?.url).toContain(`/feedback?item=${itemId}#c-`);
  });

  it("notifies an @mentioned member with a link to the comment", async () => {
    as(carol, "MEMBER");
    const c = await body(await post(`<@${alice}> can we get this in Q4?`));
    const n = await prisma.notification.findFirst({
      where: { orgId, userId: alice, type: "feedback.comment.mentioned", refId: itemId },
    });
    expect(n?.url).toBe(`/test-org/feedback?item=${itemId}#c-${c.id}`);
  });

  it("never shows an internal note to a member, and shows it to staff", async () => {
    await prisma.comment.create({
      data: { orgId, subjectType: "feedback", subjectId: itemId, authorId: alice, content: "dup of SSO bug?", visibility: "INTERNAL" },
    });
    as(bob, "MEMBER");
    expect(JSON.stringify(await thread())).not.toContain("dup of SSO bug?");
    as(alice, "ADMIN");
    expect(JSON.stringify(await thread())).toContain("dup of SSO bug?");
  });

  it("refuses a comment from someone without COMMENT_CREATE, unless it is their own request", async () => {
    as(carol, "VIEWER");
    expect((await post("drive-by")).status).toBe(403);
    as(bob, "VIEWER");
    expect((await post("Answering the team: yes, all reports.")).status).toBe(201);
  });

  it("records the old words when the author edits, and refuses anyone else's edit", async () => {
    as(carol, "MEMBER");
    const res = await PATCH(req("PATCH", { content: "Would love this for night shifts and weekends." }), p({ commentId: top }));
    expect(res.status).toBe(200);
    const edited = await body(res);
    expect(edited.editedAt).not.toBeNull();
    expect(edited.revisionCount).toBe(1);

    const history = await body(await REVISIONS(req("GET"), p({ commentId: top })));
    expect(history[0].content).toBe("Would love this for night shifts.");

    as(bob, "MEMBER");
    expect((await PATCH(req("PATCH", { content: "hijack" }), p({ commentId: top }))).status).toBe(403);
  });

  it("leaves a tombstone for a deleted comment with replies, without its words or author", async () => {
    as(bob, "MEMBER");
    expect((await DELETE(req("DELETE"), p({ commentId: top }))).status).toBe(403);

    const before = (await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } })).commentCount;
    as(carol, "MEMBER");
    expect((await DELETE(req("DELETE"), p({ commentId: top }))).status).toBe(200);
    expect((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } })).commentCount).toBe(before - 1);

    as(bob, "MEMBER");
    const t = await thread();
    const tomb = t.find((c: { id: string }) => c.id === top);
    expect(tomb).toMatchObject({ deleted: true, content: null, author: null });
    expect(tomb.replies).toHaveLength(2);
  });

  it("audits staff deleting someone else's comment", async () => {
    as(bob, "MEMBER");
    const c = await body(await post("off topic"));
    as(alice, "ADMIN");
    expect((await DELETE(req("DELETE"), p({ commentId: c.id }))).status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { orgId, action: "feedback.comment.deleted", entityId: c.id } });
    expect(audit).not.toBeNull();
  });

  it("closes a locked thread to members but not to staff", async () => {
    await prisma.feedbackItem.update({ where: { id: itemId }, data: { lockedAt: new Date() } });
    as(bob, "MEMBER");
    expect((await post("still here?")).status).toBe(423);
    as(alice, "ADMIN");
    expect((await post("Locking while we scope this.")).status).toBe(201);
    await prisma.feedbackItem.update({ where: { id: itemId }, data: { lockedAt: null } });
  });

  it("sends the discussion of a merged request to its survivor", async () => {
    const survivor = await prisma.feedbackItem.create({
      data: { orgId, authorId: bob, type: "FEATURE", title: `${PREFIX} survivor` },
    });
    await prisma.feedbackItem.update({ where: { id: itemId }, data: { status: "MERGED", mergedIntoId: survivor.id } });
    as(bob, "MEMBER");
    const res = await post("hello?");
    expect(res.status).toBe(409);
    expect((await body(res)).mergedIntoId).toBe(survivor.id);
    await prisma.feedbackItem.update({ where: { id: itemId }, data: { status: "OPEN", mergedIntoId: null } });
  });

  describe("while the request is merged", () => {
    let survivorId: string;
    beforeAll(async () => {
      const survivor = await prisma.feedbackItem.create({
        data: { orgId, authorId: alice, type: "FEATURE", title: `${PREFIX} survivor 2` },
      });
      survivorId = survivor.id;
      await prisma.feedbackItem.update({ where: { id: itemId }, data: { status: "MERGED", mergedIntoId: survivorId } });
    });
    afterAll(async () => {
      await prisma.feedbackItem.update({ where: { id: itemId }, data: { status: "OPEN", mergedIntoId: null } });
    });

    it("refuses a status change, through the API and the assistant", async () => {
      as(alice, "ADMIN");
      const res = await PUT_ITEM(req("PUT", { status: "OPEN" }), p());
      expect(res.status).toBe(409);
      const tool = await setFeedbackStatus(
        { feedbackId: itemId, status: "OPEN" },
        await memberToolCtx(orgId, alice),
      );
      expect(tool).toHaveProperty("error");
      const row = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(row).toMatchObject({ status: "MERGED", mergedIntoId: survivorId });
    });

    it("still lists it for its author, and not for other members", async () => {
      const listed = async () =>
        ((await body(await LIST(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId }) } as never))) as {
          id: string;
        }[]).some((i) => i.id === itemId);
      as(bob, "MEMBER"); // the author
      expect(await listed()).toBe(true);
      as(carol, "MEMBER");
      expect(await listed()).toBe(false);
    });

    it("keeps the thread closed after the survivor is deleted", async () => {
      await prisma.feedbackItem.delete({ where: { id: survivorId } }); // nulls mergedIntoId
      const row = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(row).toMatchObject({ status: "MERGED", mergedIntoId: null });
      as(bob, "MEMBER");
      expect((await post("is anyone there?")).status).toBe(409);
    });
  });

  it("takes the discussion with it when the request is deleted", async () => {
    as(alice, "ADMIN");
    const res = await DELETE_ITEM(req("DELETE"), { params: Promise.resolve({ orgId, feedbackId: itemId }) } as never);
    expect(res.status).toBe(200);
    expect(await prisma.comment.count({ where: { subjectType: "feedback", subjectId: itemId } })).toBe(0);
  });
});
