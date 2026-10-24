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
import { PUT as FOLLOW } from "../subscription/route";
import { POST as COMMENT } from "../comments/route";

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

let otherOrg: string | undefined;

afterAll(async () => {
  if (otherOrg) await prisma.organization.delete({ where: { id: otherOrg } });
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

  describe("under concurrency", () => {
    const statuses = (rs: Response[]) => rs.map((r) => r.status).sort();

    it("lets only one of A→B and B→A win, and leaves no loop", async () => {
      as(alice, "ADMIN");
      for (let round = 0; round < 5; round++) {
        const a = await item(`race A ${round}`, bob, [V2]);
        const b = await item(`race B ${round}`, carol, [V1]);
        const res = await Promise.all([merge(a, b), merge(b, a)]);
        expect(statuses(res)[0]).toBe(200);
        expect(statuses(res)[1]).toBeGreaterThanOrEqual(400);
        const [ra, rb] = await Promise.all([get(a), get(b)]);
        expect([ra.status, rb.status].filter((st) => st === "MERGED")).toHaveLength(1);
        expect(ra.mergedIntoId && rb.mergedIntoId).toBeFalsy();
        expect(await prisma.feedbackMerge.count({ where: { duplicateId: { in: [a, b] }, undoneAt: null } })).toBe(1);
      }
    });

    it("merges a duplicate once when two merges of it race, counting its votes once", async () => {
      as(alice, "ADMIN");
      const survivor = await item("race survivor", alice, []);
      const dup = await item("race dup", bob, [V1, V2]);
      const res = await Promise.all([merge(dup, survivor), merge(dup, survivor)]);
      expect(statuses(res)).toEqual([200, 409]);
      expect(await prisma.feedbackMerge.count({ where: { duplicateId: dup } })).toBe(1);
      expect((await get(survivor)).voteCount).toBe(2);
    });

    it("never builds a chain when one merge targets a request another is merging away", async () => {
      as(alice, "ADMIN");
      const c = await item("chain C", alice);
      const a = await item("chain A", bob);
      const b = await item("chain B", carol);
      await Promise.all([merge(a, c), merge(b, a)]);
      const rows = await prisma.feedbackItem.findMany({ where: { id: { in: [a, b, c] } } });
      const merged = new Set(rows.filter((r) => r.status === "MERGED").map((r) => r.id));
      for (const r of rows) if (r.mergedIntoId) expect(merged.has(r.mergedIntoId)).toBe(false);
    });
  });

  it("refuses a survivor whose own survivor was deleted (merged, with no pointer left)", async () => {
    as(alice, "ADMIN");
    const orphan = await item("orphan", alice);
    await prisma.feedbackItem.update({ where: { id: orphan }, data: { status: "MERGED", mergedIntoId: null } });
    const dup = await item("into orphan", bob);
    expect((await merge(dup, orphan)).status).toBe(404);
    expect((await get(dup)).status).toBe("OPEN");
  });

  it("refuses a survivor from another org as not found", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    otherOrg = (await prisma.organization.create({ data: { name: `${PREFIX} ${stamp}`, slug: `fb-merge-other-${stamp}` } })).id;
    const foreign = await prisma.feedbackItem.create({
      data: { orgId: otherOrg, authorId: alice, type: "BUG", title: `${PREFIX} foreign` },
    });
    as(alice, "ADMIN");
    const dup = await item("into foreign", bob);
    expect((await merge(dup, foreign.id)).status).toBe(404);
    expect((await get(dup)).status).toBe("OPEN");
  });

  it("applies ABAC rules on the survivor too", async () => {
    const survivor = await item("abac survivor", carol);
    const dup = await item("abac dup", bob);
    getAuthContext.mockResolvedValue({
      userId: alice,
      orgId,
      orgRole: "ADMIN",
      permissions: RolePermissions.ADMIN,
      basePermissions: RolePermissions.ADMIN,
      abacRules: [{ effect: "deny", actions: ["ORG_UPDATE"], conditions: [{ attr: "createdById", op: "eq", value: carol }] }],
    });
    expect((await merge(dup, survivor)).status).toBe(403);
    expect((await get(dup)).status).toBe("OPEN");
  });

  it("applies ABAC rules on the request it really lands on, when the named one was merged further", async () => {
    as(alice, "ADMIN");
    const final = await item("abac final", carol);
    const named = await item("abac named", alice);
    expect((await merge(named, final)).status).toBe(200);
    const dup = await item("abac chained dup", bob);
    getAuthContext.mockResolvedValue({
      userId: alice,
      orgId,
      orgRole: "ADMIN",
      permissions: RolePermissions.ADMIN,
      basePermissions: RolePermissions.ADMIN,
      abacRules: [{ effect: "deny", actions: ["ORG_UPDATE"], conditions: [{ attr: "createdById", op: "eq", value: carol }] }],
    });
    expect((await merge(dup, named)).status).toBe(403);
    expect((await get(dup)).status).toBe("OPEN");
    expect(await prisma.feedbackMerge.count({ where: { duplicateId: dup } })).toBe(0);
  });

  it("keeps an opt-out made after the merge when the merge is undone", async () => {
    as(alice, "ADMIN");
    const survivor = await item("optout survivor", alice);
    const dup = await item("optout dup", bob, [], [bob]);
    expect((await merge(dup, survivor)).status).toBe(200);
    // bob followed the survivor through the merge, then said stop.
    as(bob, "MEMBER");
    expect((await FOLLOW(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ following: false }) }), p(survivor))).status).toBe(200);
    as(alice, "ADMIN");
    expect((await undo(dup)).status).toBe(200);
    const row = await prisma.feedbackSubscription.findUnique({
      where: { feedbackItemId_userId: { feedbackItemId: survivor, userId: bob } },
    });
    expect(row?.unsubscribedAt).not.toBeNull();
    // ...so the next comment on the survivor doesn't reach him either.
    await prisma.notification.deleteMany({ where: { orgId, refId: survivor } });
    as(carol, "MEMBER");
    expect((await COMMENT(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ content: "any news?" }) }), p(survivor))).status).toBe(201);
    expect(await prisma.notification.count({ where: { orgId, userId: bob, refId: survivor } })).toBe(0);
  });

  it("keeps an explicit follow made after the merge when the merge is undone", async () => {
    as(alice, "ADMIN");
    const survivor = await item("follow survivor", alice);
    const dup = await item("follow dup", bob, [], [bob]);
    expect((await merge(dup, survivor)).status).toBe(200);
    // bob chose to follow the survivor himself: it's his now, not the merge's.
    as(bob, "MEMBER");
    expect((await FOLLOW(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ following: true }) }), p(survivor))).status).toBe(200);
    as(alice, "ADMIN");
    expect((await undo(dup)).status).toBe(200);
    expect(await followers(survivor)).toContain(bob);
  });
});
