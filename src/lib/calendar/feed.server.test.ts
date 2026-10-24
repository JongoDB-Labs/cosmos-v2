// COSMOS-202 (e2e DB): a calendar feed link serves the person's dated work and
// meetings, re-checks everything on every fetch, and never lets a classified
// title out, because the calendar provider's servers are what fetch it.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { renderFeed } from "./feed.server";
import { newFeedToken } from "./feed-token";
import { withCalendarFeedsEnabled } from "./feed-settings";

const NOW = new Date("2026-10-22T12:00:00Z");
const ORIGIN = "https://example.com";

describe("renderFeed (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  });

  async function setup({ enabled = true } = {}) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `cf ${stamp}`, slug: `cf-${stamp}`, settings: withCalendarFeedsEnabled({}, enabled) as object },
    });
    orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "MEMBER" } });
    const mkProject = async (key: string) => {
      const project = await prisma.project.create({ data: { orgId: org.id, name: key, key: `${key}${stamp.slice(-3).toUpperCase()}` } });
      await ensureFixtureStatuses(project.id);
      return project;
    };
    const open = await mkProject("OP");
    const secret = await mkProject("SC");
    await prisma.dataClassification.create({
      data: { orgId: org.id, projectId: secret.id, level: "CUI", appliedById: owner.id },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    let n = 0;
    const item = (projectId: string, title: string, due: string | null, extra: Record<string, unknown> = {}) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId, ticketNumber: ++n, title, description: "", columnKey: "todo",
          workItemTypeId: type.id, createdById: owner.id, assigneeId: owner.id,
          dueDate: due ? new Date(due) : null, ...extra,
        },
      });
    await item(open.id, "Ship the exporter", "2026-10-30T00:00:00Z");
    await item(open.id, "Way too far out", "2027-12-01T00:00:00Z");
    await item(open.id, "Not mine", "2026-10-30T00:00:00Z", { assigneeId: null });
    await item(open.id, "CUI//SP-PRVCY payroll fix", "2026-10-31T00:00:00Z");
    await item(secret.id, "Quietly classified work", "2026-11-02T00:00:00Z");
    const meeting = await prisma.syncMeeting.create({
      data: { orgId: org.id, title: "Sprint review", meetingDate: new Date("2026-10-24T15:00:00Z"), meetingType: "STANDUP", createdById: owner.id },
    });
    await prisma.meetingAttendee.create({ data: { meetingId: meeting.id, userId: owner.id } });
    const { token, tokenHash } = newFeedToken();
    const feed = await prisma.calendarFeed.create({ data: { orgId: org.id, userId: owner.id, tokenHash, options: {} } });
    return { org, owner, token, feed };
  }

  it("serves my dated work and meetings in the window, and nothing else", async () => {
    const { token } = await setup();
    const out = await renderFeed(token, { origin: ORIGIN, now: NOW });
    expect(out).not.toBeNull();
    const ics = out!.ics.replace(/\r\n /g, "");
    expect(ics).toMatch(/SUMMARY:OP\w*-1 Ship the exporter/);
    expect(ics).toContain("SUMMARY:Sprint review");
    expect(ics).not.toContain("Way too far out"); // beyond +180 days
    expect(ics).not.toContain("Not mine"); // not assigned to me
  });

  it("never lets a marked or classified title out, whatever the options", async () => {
    const { token } = await setup();
    const ics = (await renderFeed(token, { origin: ORIGIN, now: NOW }))!.ics.replace(/\r\n /g, "");
    expect(ics).not.toMatch(/payroll|PRVCY|Quietly classified/);
    // Both still occupy their day, as busy.
    expect(ics.match(/SUMMARY:Busy/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261031");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261102");
  });

  it("is byte-identical across fetches when nothing changed (ETag-stable)", async () => {
    const { token } = await setup();
    const a = await renderFeed(token, { origin: ORIGIN, now: NOW });
    const b = await renderFeed(token, { origin: ORIGIN, now: new Date(NOW.getTime() + 60_000) });
    expect(b!.ics).toBe(a!.ics);
  });

  it("serves nothing once the org turns feeds off, the link is revoked, or the person leaves", async () => {
    const off = await setup({ enabled: false });
    expect(await renderFeed(off.token, { origin: ORIGIN, now: NOW })).toBeNull();

    const revoked = await setup();
    await prisma.calendarFeed.update({ where: { id: revoked.feed.id }, data: { revokedAt: NOW } });
    expect(await renderFeed(revoked.token, { origin: ORIGIN, now: NOW })).toBeNull();

    const left = await setup();
    await prisma.orgMember.deleteMany({ where: { orgId: left.org.id, userId: left.owner.id } });
    expect(await renderFeed(left.token, { origin: ORIGIN, now: NOW })).toBeNull();

    expect(await renderFeed(newFeedToken().token, { origin: ORIGIN, now: NOW })).toBeNull();
  });
});
