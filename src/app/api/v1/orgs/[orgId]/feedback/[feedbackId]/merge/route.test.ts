// @vitest-environment node
//
// Feedback discussion, Phase 2: staff merging one request into another, and
// undoing it. Against the REAL e2e DB (test-org: alice ADMIN, bob and carol
// MEMBER). Only getAuthContext is mocked. Voter ids are synthetic: FeedbackVote
// has no user FK.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { POST as MERGE, DELETE as UNDO } from "./route";
import { POST as VOTE } from "../vote/route";

const PREFIX = "[fb-merge-test]";
const V1 = "aaaaaaaa-0000-4000-8000-000000000001"; // votes on both
const V2 = "aaaaaaaa-0000-4000-8000-000000000002"; // votes on the duplicate only
let orgId: string;
let alice: string;
let bob: string;
let carol: string;

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
const p = (feedbackId: string) => ({ params: Promise.resolve({ orgId, feedbackId }) }) as never;
const merge = (dup: string, survivorId: string) =>
  MERGE(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ survivorId }) }), p(dup));
const undo = (dup: string) => UNDO(new NextRequest("http://localhost/x", { method: "DELETE" }), p(dup));
async function item(title: string, authorId: string, voters: string[] = [], followers: string[] = []) {
  const row = await prisma.feedbackItem.create({
    data: {
      orgId,
      authorId,
      type: "FEATURE",
      title: `${PREFIX} ${title}`,
      voteCount: voters.length,
      votes: { create: voters.map((userId) => ({ userId })) },
    },
  });
  if (followers.length) {
    await prisma.feedbackSubscription.createMany({
      data: followers.map((userId) => ({ orgId, feedbackItemId: row.id, userId, reason: "author" })),
    });
  }
  return row.id;
}
const get = (id: string) => prisma.feedbackItem.findUniqueOrThrow({ where: { id } });
const voters = async (id: string) =>
  new Set((await prisma.feedbackVote.findMany({ where: { feedbackItemId: id } })).map((v) => v.userId));
const followers = async (id: string) =>
  new Set((await prisma.feedbackSubscription.findMany({ where: { feedbackItemId: id } })).map((s) => s.userId));

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
  await prisma.feedbackMerge.deleteMany({ where: { duplicateId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { orgId, refId: { in: ids } } });
  await prisma.feedbackItem.deleteMany({ where: { id: { in: ids } } });
});

describe("merging feedback (e2e DB)", () => {
  it("merges a duplicate: votes and followers carry over, its author is told, it's audited", async () => {
    const survivor = await item("survivor", alice, [V1], [alice]);
    // carol already follows the survivor through an EARLIER merge; this one must
    // neither record her nor take her away on undo.
    await prisma.feedbackSubscription.create({
      data: { orgId, feedbackItemId: survivor, userId: carol, reason: "merged" },
    });
    const dup = await item("dup", bob, [V1, V2], [bob, alice, carol]);
    as(alice, "ADMIN");
    expect((await merge(dup, survivor)).status).toBe(200);
    expect((await prisma.feedbackMerge.findFirstOrThrow({ where: { duplicateId: dup } })).addedSubscriberIds).toEqual([
      bob,
    ]);

    expect(await get(dup)).toMatchObject({ status: "MERGED", mergedIntoId: survivor, voteCount: 0 });
    expect(await voters(dup)).toEqual(new Set([V1, V2])); // kept for an undo
    expect((await get(survivor)).voteCount).toBe(2); // V2 added once, V1 not doubled
    expect(await voters(survivor)).toEqual(new Set([V1, V2]));
    expect(await followers(survivor)).toEqual(new Set([alice, bob, carol]));
    expect(
      await prisma.notification.count({ where: { orgId, userId: bob, type: "feedback.merged", refId: survivor } }),
    ).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId, entityId: dup, action: "feedback.merged" } })).toBe(1);

    // A merged request can't be voted on.
    as(carol, "MEMBER");
    expect((await VOTE(new NextRequest("http://localhost/x", { method: "POST" }), p(dup))).status).toBe(409);

    // Undo gives back exactly what the merge added, and nothing it didn't.
    as(alice, "ADMIN");
    expect((await undo(dup)).status).toBe(200);
    expect(await get(dup)).toMatchObject({ status: "OPEN", mergedIntoId: null, voteCount: 2 });
    expect(await get(survivor)).toMatchObject({ voteCount: 1 });
    expect(await voters(survivor)).toEqual(new Set([V1]));
    expect(await followers(survivor)).toEqual(new Set([alice, carol]));
    const row = await prisma.feedbackMerge.findFirstOrThrow({ where: { duplicateId: dup } });
    expect(row.undoneById).toBe(alice);
    expect(row.undoneAt).not.toBeNull();
  });

  it("is staff only", async () => {
    const survivor = await item("s2", alice);
    const dup = await item("d2", bob);
    as(bob, "MEMBER");
    expect((await merge(dup, survivor)).status).toBe(403);
    expect((await get(dup)).status).toBe("OPEN");
  });

  it("merges into the request that holds the discussion, never into a merged one", async () => {
    const top = await item("top", alice);
    const mid = await item("mid", alice);
    const leaf = await item("leaf", bob);
    as(alice, "ADMIN");
    expect((await merge(mid, top)).status).toBe(200);
    expect((await merge(leaf, mid)).status).toBe(200);
    expect((await get(leaf)).mergedIntoId).toBe(top);
  });

  it("refuses a merge into itself, of a merged request, and of one others were merged into", async () => {
    const a = await item("a", alice);
    const b = await item("b", alice);
    const c = await item("c", alice);
    as(alice, "ADMIN");
    expect((await merge(a, a)).status).toBe(409);
    expect((await merge(b, a)).status).toBe(200);
    expect((await merge(b, c)).status).toBe(409); // already merged
    expect((await merge(a, c)).status).toBe(409); // b points at a
    expect((await get(a)).status).toBe("OPEN");
  });

  it("undoes a merge in the backfill's shape back to DECLINED", async () => {
    // What 20261023160000_feedback_discussion_backfill writes for an old intake
    // duplicate: no vote moves, the duplicate's author added as a follower.
    const survivor = await item("bf-survivor", alice, [], [alice]);
    const dup = await item("bf-dup", bob, [], [bob]);
    await prisma.feedbackItem.update({ where: { id: dup }, data: { status: "MERGED", mergedIntoId: survivor } });
    await prisma.feedbackSubscription.create({ data: { orgId, feedbackItemId: survivor, userId: bob, reason: "merged" } });
    await prisma.feedbackMerge.create({
      data: { orgId, duplicateId: dup, survivorId: survivor, previousStatus: "DECLINED", source: "intake", addedSubscriberIds: [bob] },
    });
    as(alice, "ADMIN");
    expect((await undo(dup)).status).toBe(200);
    expect(await get(dup)).toMatchObject({ status: "DECLINED", mergedIntoId: null });
    expect(await followers(survivor)).toEqual(new Set([alice]));
  });

  it("can still be undone after the survivor was deleted", async () => {
    const survivor = await item("gone", alice);
    const dup = await item("orphan", bob, [V2]);
    as(alice, "ADMIN");
    expect((await merge(dup, survivor)).status).toBe(200);
    await prisma.feedbackItem.delete({ where: { id: survivor } });
    expect((await undo(dup)).status).toBe(200);
    expect(await get(dup)).toMatchObject({ status: "OPEN", mergedIntoId: null, voteCount: 1 });
  });
});
