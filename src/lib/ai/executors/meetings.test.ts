import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listMeetings, createMeeting, updateMeeting, deleteMeeting } from "./meetings";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("meetings executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `mtg-test ${stamp}`, slug: `mtg-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, ctx, denyCtx, ownerId: owner.id };
  }

  it("create_meeting persists a SyncMeeting with the actor as creator", async () => {
    const { ctx, ownerId } = await makeOrg();
    const res = (await createMeeting(
      { title: "Standup", meetingDate: "2026-07-15T09:00:00.000Z", meetingType: "STANDUP" },
      ctx,
    )) as { created: boolean; id: string };
    expect(res.created).toBe(true);
    const row = await prisma.syncMeeting.findUnique({ where: { id: res.id } });
    expect(row?.title).toBe("Standup");
    expect(row?.createdById).toBe(ownerId);
    expect(row?.meetingType).toBe("STANDUP");
  });

  it("list_meetings round-trips and update/delete mutate the row", async () => {
    const { ctx } = await makeOrg();
    const created = (await createMeeting({ title: "Retro", meetingDate: "2026-07-16T09:00:00.000Z" }, ctx)) as {
      id: string;
    };
    const list = (await listMeetings({}, ctx)) as { count: number };
    expect(list.count).toBe(1);

    const upd = (await updateMeeting({ meetingId: created.id, status: "CANCELLED" }, ctx)) as { updated: boolean };
    expect(upd.updated).toBe(true);
    expect((await prisma.syncMeeting.findUnique({ where: { id: created.id } }))?.status).toBe("CANCELLED");

    const del = (await deleteMeeting({ meetingId: created.id }, ctx)) as { deleted: boolean };
    expect(del.deleted).toBe(true);
    expect(await prisma.syncMeeting.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("denies a non-member (no MEETING_* permission)", async () => {
    const { denyCtx } = await makeOrg();
    expect(await listMeetings({}, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await createMeeting({ title: "x", meetingDate: "2026-07-15T09:00:00.000Z" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await deleteMeeting({ meetingId: NON_MEMBER }, denyCtx)).toEqual({ error: "Insufficient permissions" });
  });
});
