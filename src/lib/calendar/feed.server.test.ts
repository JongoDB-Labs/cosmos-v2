// COSMOS-202 (e2e DB): a calendar feed link serves the person's dated work and
// meetings, re-checks everything on every fetch, and never lets a classified
// title out, because the calendar provider's servers are what fetch it.
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { patchOrgSettings } from "@/lib/org/patch-settings.server";
import { renderFeed } from "./feed.server";
import { newFeedToken } from "./feed-token";
import type { FeedOptions } from "./feed-events";

const NOW = new Date("2026-10-22T12:00:00Z");
const ORIGIN = "https://example.com";
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("renderFeed (e2e DB)", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  });

  async function setup({ enabled = true, role = "MEMBER" as OrgRole, options = {} as Partial<FeedOptions> } = {}) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Our own person: the seeded users are shared by every DB spec running at once.
    const owner = await prisma.user.create({ data: { email: `cf-${stamp}@feeds.test`, displayName: `Feed owner ${stamp}` } });
    userIds.push(owner.id);
    const org = await prisma.organization.create({ data: { name: `cf ${stamp}`, slug: `cf-${stamp}` } });
    orgIds.push(org.id);
    // The org's switch, written the way the settings route writes it.
    await patchOrgSettings(org.id, { merge: { key: "calendarFeeds", fields: { enabled } } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role } });
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
    const mkFeed = async (idpConnId: string | null = null) => {
      const { token, tokenHash } = newFeedToken();
      const feed = await prisma.calendarFeed.create({ data: { orgId: org.id, userId: owner.id, tokenHash, options, idpConnId } });
      return { token, feed };
    };
    const { token, feed } = await mkFeed();
    return { org, owner, token, feed, open, secret, mkFeed };
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
    const ics = unfold((await renderFeed(token, { origin: ORIGIN, now: NOW }))!.ics);
    expect(ics).not.toMatch(/payroll|PRVCY|Quietly classified/);
    // Both still occupy their day, as busy.
    expect(ics.match(/SUMMARY:Busy/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261031");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261102");
  });

  it("leaves out a meeting the person may not read, by the rule every meeting door uses", async () => {
    const { org, owner, token, open } = await setup();
    const inOpen = await prisma.syncMeeting.create({
      data: { orgId: org.id, projectId: open.id, title: "Planning in OP", meetingDate: new Date("2026-10-25T15:00:00Z"), createdById: owner.id },
    });
    await prisma.meetingAttendee.create({ data: { meetingId: inOpen.id, userId: owner.id } });
    const ics = async () => (await renderFeed(token, { origin: ORIGIN, now: NOW }))!.ics.replace(/\r\n /g, "");
    expect(await ics()).toContain("SUMMARY:Planning in OP"); // the positive control
    await prisma.orgMember.updateMany({
      where: { orgId: org.id, userId: owner.id },
      data: { abacRules: { rules: [{ effect: "deny", actions: ["MEETING_READ"], conditions: [{ attr: "projectId", op: "eq", value: open.id }] }] } },
    });
    const after = await ics();
    expect(after).not.toContain("Planning in OP");
    expect(after).toContain("SUMMARY:Sprint review"); // the deny is that project's only
  });

  it("is byte-identical across fetches when nothing changed (ETag-stable)", async () => {
    const { token } = await setup();
    const a = await renderFeed(token, { origin: ORIGIN, now: NOW });
    const b = await renderFeed(token, { origin: ORIGIN, now: new Date(NOW.getTime() + 60_000) });
    expect(b!.ics).toBe(a!.ics);
  });

  it("holds an owner's link to the org's restrictions: no break-glass for a link", async () => {
    const { org, owner, token, open } = await setup({ role: "OWNER", options: { intervals: true } });
    const member = await prisma.orgMember.findFirstOrThrow({ where: { orgId: org.id, userId: owner.id } });
    await prisma.projectMember.create({ data: { projectId: open.id, orgMemberId: member.id, role: "MEMBER" } });
    await prisma.interval.create({
      data: { orgId: org.id, projectId: open.id, number: 9, name: "Sprint 9", startDate: new Date("2026-10-20T00:00:00Z"), endDate: new Date("2026-11-02T00:00:00Z") },
    });
    const ics = async () => unfold((await renderFeed(token, { origin: ORIGIN, now: NOW }))!.ics);
    // The positive control: with no restriction, the owner's link carries the sprint.
    const before = await ics();
    expect(before).toMatch(/SUMMARY:OP\w*: Sprint 9/);

    // An unconditional restriction takes SPRINT_READ from everyone. The owner's
    // own session keeps it (its break-glass); their link must not.
    await prisma.orgSecuritySettings.create({
      data: { orgId: org.id, actionRestrictions: { rules: [{ effect: "deny", actions: ["SPRINT_READ"], conditions: [] }] } },
    });
    const after = await ics();
    expect(after).not.toContain("Sprint 9");
    expect(after).toContain("SUMMARY:Sprint review"); // only what was restricted went

    // Lifted again, the link is as it was.
    await prisma.orgSecuritySettings.update({ where: { orgId: org.id }, data: { actionRestrictions: {} } });
    expect(await ics()).toBe(before);
  });

  it("where the org requires single sign-on, serves only a link made through the org's IdP", async () => {
    const { org, token: madeWithoutIdp, mkFeed } = await setup();
    // Single sign-on can only be required of a GOV-class org (sso-enforcement).
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { tenantClass: true } })).tenantClass).toBe("GOV");
    const conn = await prisma.idpConnection.create({
      data: { orgId: org.id, issuerUrl: "https://idp.example.test", clientId: "c", clientSecretEnc: "not-opened-by-these-tests", enabled: true },
    });
    const { token: viaIdp } = await mkFeed(conn.id);
    // Made through a connection that is no longer the org's (one since replaced).
    const { token: viaOther } = await mkFeed(randomUUID());
    const serves = async (t: string) => (await renderFeed(t, { origin: ORIGIN, now: NOW })) !== null;

    // Connected but not required: every link works, as before.
    expect([await serves(madeWithoutIdp), await serves(viaIdp), await serves(viaOther)]).toEqual([true, true, true]);

    await prisma.idpConnection.update({ where: { id: conn.id }, data: { enforced: true } });
    expect(await serves(viaIdp)).toBe(true);
    // Fails closed: no recorded sign-in, or another connection's, is refused.
    expect(await serves(madeWithoutIdp)).toBe(false);
    expect(await serves(viaOther)).toBe(false);

    await prisma.idpConnection.update({ where: { id: conn.id }, data: { enforced: false } });
    expect([await serves(madeWithoutIdp), await serves(viaIdp), await serves(viaOther)]).toEqual([true, true, true]);
  });

  it("gives a Teams meeting its join link, never on a busy row", async () => {
    const { org, owner, token, secret, mkFeed } = await setup();
    const meet = async (title: string, join: string, extra: Record<string, unknown> = {}) => {
      const m = await prisma.syncMeeting.create({
        data: { orgId: org.id, title, meetingDate: new Date("2026-10-26T15:00:00Z"), createdById: owner.id, teamsJoinUrl: join, ...extra },
      });
      await prisma.meetingAttendee.create({ data: { meetingId: m.id, userId: owner.id } });
      return `UID:meeting-${m.id}@`;
    };
    const teams = await meet("Teams sync", "https://teams.example.test/l/meetup-join/open", { teamsHostId: owner.id });
    // The premise the feed reads the column on: the database drops a join link
    // written without a host, so a meeting that isn't a Teams one never has one.
    const stale = await meet("Was on Teams", "https://teams.example.test/l/meetup-join/stale");
    const classified = await meet("Classified sync", "https://teams.example.test/l/meetup-join/secret", { teamsHostId: owner.id, projectId: secret.id });

    const ics = unfold((await renderFeed(token, { origin: ORIGIN, now: NOW }))!.ics);
    // Every meeting is in the feed; only the one shown in full gets the link.
    for (const uid of [teams, stale, classified]) expect(ics).toContain(uid);
    expect(ics).toContain("DESCRIPTION:Join the Teams meeting: https://teams.example.test/l/meetup-join/open");
    expect(ics.match(/meetup-join/g)).toHaveLength(1);
    expect(ics).not.toContain("Classified sync");

    const busy = await mkFeed();
    await prisma.calendarFeed.update({ where: { id: busy.feed.id }, data: { options: { busyOnly: true } } });
    const busyIcs = unfold((await renderFeed(busy.token, { origin: ORIGIN, now: NOW }))!.ics);
    expect(busyIcs).toContain(teams); // the positive control: the meeting is there, as busy
    expect(busyIcs).not.toContain("meetup-join");
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
