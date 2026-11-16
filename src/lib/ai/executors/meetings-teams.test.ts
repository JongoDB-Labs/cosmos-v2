// Cosmo's list_meetings gives a meeting's Teams join link to exactly the
// people the REST list gives it to: those who can see the meeting. A meeting
// under a team-scoped project the actor isn't on is left out, link and all.
// And Cosmo's edits reach Outlook when REST's do. (Its creates are followed
// all the way into Outlook in meetings-outlook.db.test.ts.)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { listMeetings, createMeeting, updateMeeting, deleteMeeting } from "./meetings";
import { memberToolCtx } from "@/lib/testing/tool-auth";

// Only the push is replaced: the test asks whether Cosmo's edits reach
// Outlook the way REST's do, not what Microsoft then does with them.
const pushed = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/microsoft/calendar-sync.server")>()),
  syncMeetingSoon: (_orgId: string, meetingId: string) => void pushed.push(meetingId),
}));

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const joinOf = (t: string) => `https://teams.microsoft.com/l/meetup-join/cosmo-${stamp}-${t}`;
let orgId = "", insider = "", outsider = "", hidden = "", open = "", restricted = "";

beforeAll(async () => {
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@cmt.test`, displayName: "Insider" } })).id;
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@cmt.test`, displayName: "Outsider" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `cmt ${stamp}`, slug: `cmt-${stamp}` } })).id;
  const m = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER" } });
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER" } });
  const project = await prisma.project.create({ data: { orgId, name: "R", key: `CM${stamp.slice(-3).toUpperCase()}`, teamScopedAccess: true } });
  await prisma.projectMember.create({ data: { projectId: project.id, orgMemberId: m.id, role: "MEMBER" } });
  restricted = project.id;
  const meeting = async (projectId: string | null, t: string) =>
    (await prisma.syncMeeting.create({
      data: { orgId, projectId, title: t, meetingDate: new Date(), createdById: insider, teamsHostId: insider, teamsJoinUrl: joinOf(t) },
    })).id;
  hidden = await meeting(project.id, "hidden");
  open = await meeting(null, "open");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${stamp}@cmt.test` } } }).catch(() => undefined);
});

type Listed = { meetings: { id: string; teamsJoinUrl?: string | null }[] };

describe("list_meetings and Teams join links (e2e DB)", () => {
  it("gives the team each meeting's join link", async () => {
    const res = (await listMeetings({}, await memberToolCtx(orgId, insider))) as Listed;
    const byId = new Map(res.meetings.map((m) => [m.id, m.teamsJoinUrl]));
    expect(byId.get(hidden)).toBe(joinOf("hidden"));
    expect(byId.get(open)).toBe(joinOf("open"));
  });

  it("leaves a hidden project's meeting, and its link, out for everyone else", async () => {
    const res = (await listMeetings({}, await memberToolCtx(orgId, outsider))) as Listed;
    expect(res.meetings.map((m) => m.id)).toEqual([open]);
    expect(res.meetings[0].teamsJoinUrl).toBe(joinOf("open")); // the field is there to be left out
    expect(JSON.stringify(res)).not.toContain(joinOf("hidden"));
  });
});

describe("create_meeting under a hidden project, and update_meeting and delete_meeting reaching Outlook (e2e DB)", () => {
  beforeEach(() => void pushed.splice(0));

  it("a create under a project the actor can't see is refused and saves nothing; the team's own goes through", async () => {
    const refused = (await createMeeting(
      { title: `refused ${stamp}`, meetingDate: "2026-12-01T10:00:00.000Z", projectId: restricted },
      await memberToolCtx(orgId, outsider),
    )) as { error?: string };
    expect(refused.error).toBeTruthy();
    expect(await prisma.syncMeeting.count({ where: { orgId, title: `refused ${stamp}` } })).toBe(0);
    const made = (await createMeeting(
      { title: `made by Cosmo ${stamp}`, meetingDate: "2026-12-01T10:00:00.000Z", projectId: restricted },
      await memberToolCtx(orgId, insider),
    )) as { created?: boolean; id?: string };
    expect(made.created).toBe(true); // the positive control: the same create, by someone on the team
    expect(await prisma.syncMeeting.count({ where: { orgId, title: `made by Cosmo ${stamp}` } })).toBe(1);
  });

  it("a title change pushes the meeting to Outlook; a notes-only change doesn't", async () => {
    const ctx = await memberToolCtx(orgId, insider);
    const notes = (await updateMeeting({ meetingId: open, notes: "agenda" }, ctx)) as { updated?: boolean };
    expect(notes.updated).toBe(true); // the edit itself went through
    expect(pushed).toEqual([]);
    const titled = (await updateMeeting({ meetingId: open, title: "CUI review" }, ctx)) as { updated?: boolean };
    expect(titled.updated).toBe(true);
    expect(pushed).toEqual([open]);
  });

  it("deleting a meeting pushes it, so everyone's Outlook copy and its Teams meeting go too", async () => {
    // A member can't delete meetings; an admin can.
    const admin = (await prisma.user.create({ data: { email: `admin-${stamp}@cmt.test`, displayName: "Admin" } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: admin, role: "ADMIN" } });
    const ctx = await memberToolCtx(orgId, admin);
    const doomed = (await prisma.syncMeeting.create({
      data: { orgId, title: "doomed", meetingDate: new Date(), createdById: insider, teamsHostId: insider, teamsJoinUrl: joinOf("doomed") },
    })).id;
    const res = (await deleteMeeting({ meetingId: doomed }, ctx)) as { deleted?: boolean };
    expect(res.deleted).toBe(true);
    expect(pushed).toEqual([doomed]);
  });

  it("a refused edit pushes nothing (the outsider can't see the hidden meeting)", async () => {
    const res = (await updateMeeting({ meetingId: hidden, title: "x" }, await memberToolCtx(orgId, outsider))) as { error?: string };
    expect(res.error).toBe("Meeting not found");
    expect(pushed).toEqual([]);
  });
});
