// @vitest-environment node
//
// Reading a meeting honours project visibility everywhere the list does. The
// list already hid a team-scoped project's meetings from people outside its
// team (and from an API key scoped to other projects), but fetching one by id,
// or its attendees or Outlook invitation, didn't ask: a meeting's notes,
// transcript, attendees' stand-up notes and Teams join link reached anyone who
// knew its id. Now a hidden meeting answers exactly as a missing one does.
// Meetings under no project stay governed by MEETING_READ alone.
// Through the real routes, against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { apiKeyAuthContext } from "@/lib/auth/api-key";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { Permission, hasPermission } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as listMeetings } from "./route";
import { GET as getMeeting } from "./[meetingId]/route";
import { GET as getAttendees } from "./[meetingId]/attendees/route";
import { GET as getInvite } from "./[meetingId]/outlook-invite/route";

const stamp = Math.random().toString(36).slice(2, 8);
/** Each meeting's own join link, so a response can be searched for one in particular. */
const joinOf = (title: string) => `https://teams.microsoft.com/l/meetup-join/visibility-${stamp}-${title.replace(/ /g, "-")}`;
const NOTE = `standup-notes-${stamp}`;
let orgId = "", restricted = "", open = "", outsider = "", insider = "";
let hidden = "", orgLevel = "", inOpen = "";

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@mrv.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@mrv.test`, displayName: "Insider" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `mrv ${stamp}`, slug: `mrv-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (await prisma.project.create({ data: { orgId, name: "R", key: `MR${key}`, teamScopedAccess: true } })).id;
  open = (await prisma.project.create({ data: { orgId, name: "O", key: `MO${key}` } })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
  const meeting = async (projectId: string | null, title: string) =>
    (await prisma.syncMeeting.create({
      data: {
        orgId, projectId, title, meetingDate: new Date(), createdById: insider, notes: NOTE,
        teamsHostId: insider, teamsJoinUrl: joinOf(title),
        attendees: { create: [{ userId: insider, blockers: NOTE }] },
      },
    })).id;
  hidden = await meeting(restricted, "hidden");
  orgLevel = await meeting(null, "org level");
  inOpen = await meeting(open, "open project");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [outsider, insider] } } }).catch(() => undefined);
});

/** A member whose roles grant every bit: only visibility can refuse them. */
const member = (userId: string, extra: Partial<AuthContext> = {}): AuthContext =>
  ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n, ...extra });
const req = () => new NextRequest("http://localhost/x");
const at = (meetingId: string) => ({ params: Promise.resolve({ orgId, meetingId }) });
const MISSING = "00000000-0000-4000-8000-000000000000";
/** The widest key there is: every scope, minted by someone on the team, scoped to the open project. */
async function widestKey(): Promise<AuthContext> {
  const ctx = await apiKeyAuthContext(orgId, { createdById: insider, scopes: [...API_KEY_SCOPES], projectIds: [open], createdAt: new Date() });
  if (!ctx) throw new Error("the key's minter isn't a member");
  // A real key: it reads work items, and no scope carries MEETING_READ.
  expect(ctx.isApiKey && hasPermission(ctx.permissions, Permission.ITEM_READ)).toBe(true);
  expect(hasPermission(ctx.permissions, Permission.MEETING_READ)).toBe(false);
  return ctx;
}

async function answer(res: Response) {
  return { status: res.status, body: await res.text() };
}

describe("a meeting by id", () => {
  it("is not found for someone outside its project's team, exactly as a missing one", async () => {
    h.ctx = member(outsider);
    const missing = await answer(await getMeeting(req(), at(MISSING)));
    expect(missing.status).toBe(404);
    const res = await answer(await getMeeting(req(), at(hidden)));
    expect(res).toEqual(missing);
    expect(res.body).not.toContain(joinOf("hidden"));
    expect(res.body).not.toContain(NOTE);
  });

  it("its attendees and its Outlook invitation are not found either", async () => {
    h.ctx = member(outsider);
    const missing = await answer(await getAttendees(req(), at(MISSING)));
    expect(await answer(await getAttendees(req(), at(hidden)))).toEqual(missing);
    const missingInvite = await answer(await getInvite(req(), at(MISSING)));
    expect(await answer(await getInvite(req(), at(hidden)))).toEqual(missingInvite);
  });

  it("the team reads it, its attendees and its join link (the positive control)", async () => {
    h.ctx = member(insider);
    const res = await getMeeting(req(), at(hidden));
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m.teamsJoinUrl).toBe(joinOf("hidden"));
    expect(m.notes).toBe(NOTE);
    const att = await getAttendees(req(), at(hidden));
    expect(att.status).toBe(200);
    expect(JSON.stringify(await att.json())).toContain(NOTE);
    expect((await getInvite(req(), at(hidden))).status).toBe(200);
  });

  it("a meeting under no project, or an open one, is anyone's with MEETING_READ, as before", async () => {
    h.ctx = member(outsider);
    for (const [id, title] of [[orgLevel, "org level"], [inOpen, "open project"]]) {
      const res = await getMeeting(req(), at(id));
      expect(res.status).toBe(200);
      expect((await res.json()).teamsJoinUrl).toBe(joinOf(title));
      expect((await getAttendees(req(), at(id))).status).toBe(200);
    }
  });

  it("no API key reads a meeting: no scope carries MEETING_READ, so even its own project's is refused", async () => {
    h.ctx = await widestKey();
    for (const id of [hidden, inOpen, orgLevel]) {
      expect((await getMeeting(req(), at(id))).status).toBe(403);
      expect((await getAttendees(req(), at(id))).status).toBe(403);
      expect((await getInvite(req(), at(id))).status).toBe(403);
    }
    // The positive control: the person who minted it reads the open project's meeting.
    h.ctx = member(insider);
    expect((await getMeeting(req(), at(inOpen))).status).toBe(200);
  });
});

describe("the meetings list", () => {
  const ids = async () => {
    const res = await listMeetings(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/meetings`), { params: Promise.resolve({ orgId }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    return { ids: (JSON.parse(text) as { id: string }[]).map((m) => m.id).sort(), text };
  };

  it("leaves out a hidden project's meetings, and with them their join links", async () => {
    h.ctx = member(outsider);
    const r = await ids();
    expect(r.ids).toEqual([orgLevel, inOpen].sort());
    expect(r.text).not.toContain(hidden);
    expect(r.text).not.toContain(joinOf("hidden"));
    expect(r.text).toContain(joinOf("open project")); // the search would find one
  });

  it("the team sees all three (the positive control)", async () => {
    h.ctx = member(insider);
    const r = await ids();
    expect(r.ids).toEqual([hidden, orgLevel, inOpen].sort());
    expect(r.text).toContain(joinOf("hidden"));
  });

  it("no API key lists meetings, whatever its scopes", async () => {
    h.ctx = await widestKey();
    const res = await listMeetings(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/meetings`), { params: Promise.resolve({ orgId }) });
    expect(res.status).toBe(403);
  });
});
