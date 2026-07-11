import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listFeedback, createFeedback, setFeedbackStatus } from "./feedback";
import type { ToolContext } from "./_ctx";

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
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, ctx, denyCtx, ownerId: owner.id };
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
});
