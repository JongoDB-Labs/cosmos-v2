import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listFeedback, createFeedback, setFeedbackStatus } from "./feedback";
import { memberToolCtx } from "@/lib/testing/tool-auth";

/** e2e-DB tests against an ISOLATED throwaway org per test (never the shared
 *  test-org). Denial is exercised with a non-member ctx (no permissions). */
const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("feedback executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `fb-test ${stamp}`, slug: `fb-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    // A real MEMBER, not a stub: triage authority is the difference between the
    // two contexts below and a literal permission mask could not show it.
    const member = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: member.id, role: "MEMBER" } });
    const ctx = await memberToolCtx(org.id, owner.id);
    const memberCtx = await memberToolCtx(org.id, member.id);
    const denyCtx = await memberToolCtx(org.id, NON_MEMBER);
    return { org, ctx, memberCtx, denyCtx, ownerId: owner.id, memberId: member.id };
  }

  it("create_feedback persists a row with the actor as author", async () => {
    const { ctx, ownerId } = await makeOrg();
    const res = (await createFeedback({ type: "BUG", title: "Crash on save", description: "boom" }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(res.created).toBe(true);
    const row = await prisma.feedbackItem.findUnique({ where: { id: res.id } });
    expect(row?.title).toBe("Crash on save");
    expect(row?.type).toBe("BUG");
    expect(row?.authorId).toBe(ownerId);
  });

  it("list_feedback round-trips created items and filters by status", async () => {
    const { ctx } = await makeOrg();
    await createFeedback({ type: "FEATURE", title: "Dark mode" }, ctx);
    const all = (await listFeedback({}, ctx)) as { count: number; feedback: { title: string }[] };
    expect(all.count).toBe(1);
    const filtered = (await listFeedback({ status: "PLANNED" }, ctx)) as { count: number };
    expect(filtered.count).toBe(0);
  });

  it("set_feedback_status triages an item", async () => {
    const { ctx } = await makeOrg();
    const created = (await createFeedback({ title: "Please add X" }, ctx)) as { id: string };
    const res = (await setFeedbackStatus({ feedbackId: created.id, status: "PLANNED" }, ctx)) as {
      updated: boolean;
    };
    expect(res.updated).toBe(true);
    const row = await prisma.feedbackItem.findUnique({ where: { id: created.id } });
    expect(row?.status).toBe("PLANNED");
  });

  it("denies a non-member (no ITEM_* permission)", async () => {
    const { denyCtx } = await makeOrg();
    expect(await listFeedback({}, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await createFeedback({ title: "x" }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await setFeedbackStatus({ feedbackId: NON_MEMBER, status: "DONE" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });

  /**
   * Triage is an ADMIN action — the assistant must not be a way round that.
   *
   * The brief mapped the assistant's feedback surface onto the item-lifecycle
   * bits so its feedback reach tracked its work-item reach. For reading and
   * filing that is right: any member may file. For STATUS it was not, because
   * `ITEM_UPDATE` is MEMBER-held and the portal gates a status change on
   * `ORG_UPDATE` with the comment "status triage is an admin action". So a
   * member could decline or ship anybody's report through Cosmo while the
   * portal answered 403 to the very same person.
   */
  describe("status triage needs org-settings permission", () => {
    it("a MEMBER cannot triage, and the row does not move", async () => {
      const { ctx, memberCtx } = await makeOrg();
      const created = (await createFeedback({ title: "Please add X" }, ctx)) as { id: string };

      const out = (await setFeedbackStatus(
        { feedbackId: created.id, status: "DECLINED" },
        memberCtx,
      )) as { updated?: boolean; error?: string };

      expect(out.updated).toBeUndefined();
      expect(out.error).toMatch(/admin action/i);
      // The row is the assertion. A message can be edited to match the code.
      expect((await prisma.feedbackItem.findUnique({ where: { id: created.id } }))?.status).toBe("OPEN");
    });

    it("...not even on an item they filed themselves", async () => {
      // The route passes `{ createdById }` to `requireAccess`, which looks like
      // an author exemption and is not one: with no ABAC rule authored,
      // `evaluateAccess` reduces to the permission bitmask. Pinned because the
      // resource attribute reads as a grant until you follow it.
      const { memberCtx } = await makeOrg();
      const mine = (await createFeedback({ title: "My own report" }, memberCtx)) as { id: string };

      const out = (await setFeedbackStatus({ feedbackId: mine.id, status: "DONE" }, memberCtx)) as {
        updated?: boolean;
        error?: string;
      };

      expect(out.updated).toBeUndefined();
      expect((await prisma.feedbackItem.findUnique({ where: { id: mine.id } }))?.status).toBe("OPEN");
    });

    it("a MEMBER can still FILE and READ — only triage is gated", async () => {
      // Otherwise this fix would have taken the feedback button away from
      // members, which is the opposite of the intent.
      const { memberCtx } = await makeOrg();

      const filed = (await createFeedback({ type: "BUG", title: "Crash" }, memberCtx)) as {
        created?: boolean;
        id?: string;
      };
      expect(filed.created).toBe(true);

      const list = (await listFeedback({}, memberCtx)) as { count?: number; error?: string };
      expect(list.error).toBeUndefined();
      expect(list.count).toBe(1);
    });

    it("control: the OWNER still triages, so the refusals are not the tool being broken", async () => {
      const { ctx } = await makeOrg();
      const created = (await createFeedback({ title: "Ship it" }, ctx)) as { id: string };

      const out = (await setFeedbackStatus({ feedbackId: created.id, status: "PLANNED" }, ctx)) as {
        updated?: boolean;
      };

      expect(out.updated).toBe(true);
      expect((await prisma.feedbackItem.findUnique({ where: { id: created.id } }))?.status).toBe("PLANNED");
    });
  });
});
