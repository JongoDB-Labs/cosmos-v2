// @vitest-environment node
//
// One rule decides who reads a meeting, at every door: the REST list, a
// meeting by id, its attendees, its Outlook invitation and its Teams state,
// and Cosmo's list_meetings and update_meeting. A meeting is readable when its
// project is visible to the caller AND MEETING_READ passes for that project
// (the bit and any policy on MEETING_READ); under no project, MEETING_READ
// alone. Before, the list asked about ITEM_READ and the by-id doors asked about
// visibility only, so the same person was shown different meetings at
// different doors, and a policy on MEETING_READ bound nowhere.
// Through the real routes and executors, as real members, against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { listMeetings as cosmoList, updateMeeting as cosmoUpdate } from "@/lib/ai/executors/meetings";
import { memberToolCtx } from "@/lib/testing/tool-auth";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as listMeetings } from "./route";
import { GET as getMeeting } from "./[meetingId]/route";
import { GET as getAttendees } from "./[meetingId]/attendees/route";
import { GET as getInvite } from "./[meetingId]/outlook-invite/route";
import { GET as getTeams } from "./[meetingId]/teams/route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", P = "", other = "";
const ids: Record<"inP" | "inOther" | "orgLevel", string> = { inP: "", inOther: "", orgLevel: "" };
const actor: Record<"control" | "denyItem" | "denyMeet" | "denyAllMeet" | "billing" | "billingNoGrant", string> = {
  control: "", denyItem: "", denyMeet: "", denyAllMeet: "", billing: "", billingNoGrant: "",
};
const denyOnP = (action: string) => ({ rules: [{ effect: "deny", actions: [action], conditions: [{ attr: "projectId", op: "eq", value: P }] }] });

beforeAll(async () => {
  for (const k of Object.keys(actor) as (keyof typeof actor)[]) {
    actor[k] = (await prisma.user.create({ data: { email: `${k.toLowerCase()}-${stamp}@doors.test`, displayName: k } })).id;
  }
  orgId = (await prisma.organization.create({ data: { name: `doors ${stamp}`, slug: `doors-${stamp}` } })).id;
  const key = stamp.slice(0, 3).toUpperCase();
  P = (await prisma.project.create({ data: { orgId, name: "P", key: `DP${key}` } })).id;
  other = (await prisma.project.create({ data: { orgId, name: "O", key: `DO${key}` } })).id;
  await prisma.orgMember.createMany({
    data: [
      { orgId, userId: actor.control, role: "MEMBER" },
      { orgId, userId: actor.denyItem, role: "MEMBER", abacRules: denyOnP("ITEM_READ") },
      { orgId, userId: actor.denyMeet, role: "MEMBER", abacRules: denyOnP("MEETING_READ") },
      { orgId, userId: actor.denyAllMeet, role: "MEMBER", abacRules: { rules: [{ effect: "deny", actions: ["MEETING_READ"], conditions: [] }] } },
      { orgId, userId: actor.billing, role: "BILLING_ADMIN", permissions: maskToDb(Permission.MEETING_READ) },
      { orgId, userId: actor.billingNoGrant, role: "BILLING_ADMIN" },
    ],
  });
  for (const [name, projectId] of [["inP", P], ["inOther", other], ["orgLevel", null]] as const) {
    ids[name] = (await prisma.syncMeeting.create({
      data: {
        orgId, projectId, title: `${name}-${stamp}`, meetingDate: new Date(), createdById: actor.control, notes: `notes-${name}`,
        teamsHostId: actor.control, teamsJoinUrl: `https://teams.microsoft.com/l/meetup-join/doors-${stamp}-${name}`,
      },
    })).id;
  }
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(actor) } } }).catch(() => undefined);
});

const req = () => new NextRequest("http://localhost/x");
const at = (meetingId: string) => ({ params: Promise.resolve({ orgId, meetingId }) });
const nameOf = (id: string) => (Object.keys(ids) as (keyof typeof ids)[]).find((k) => ids[k] === id) ?? id;
const sorted = (xs: string[]) => [...xs].sort();

/** The meetings each door gives this person, by name. */
async function doors(userId: string): Promise<Record<string, string[]>> {
  h.ctx = await loadMemberAuthContext(orgId, userId);
  const out: Record<string, string[]> = { list: [], byId: [], attendees: [], invite: [], teams: [], cosmoList: [], cosmoNamed: [], cosmoUpdate: [] };
  const list = await listMeetings(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/meetings`), { params: Promise.resolve({ orgId }) });
  if (list.status === 200) out.list = ((await list.json()) as { id: string }[]).map((m) => nameOf(m.id)).filter((n) => n in ids);
  for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
    const id = ids[name];
    if ((await getMeeting(req(), at(id))).status === 200) out.byId.push(name);
    if ((await getAttendees(req(), at(id))).status === 200) out.attendees.push(name);
    if ((await getInvite(req(), at(id))).status === 200) out.invite.push(name);
    if ((await getTeams(req(), at(id))).status === 200) out.teams.push(name);
  }
  const tc = await memberToolCtx(orgId, userId);
  const listed = (await cosmoList({}, tc)) as { meetings?: { id: string }[] };
  out.cosmoList = (listed.meetings ?? []).map((m) => nameOf(m.id));
  // Naming the project: every meeting under a project is there, or none.
  for (const projectId of [P, other]) {
    const named = (await cosmoList({ projectId }, tc)) as { meetings?: { id: string }[] };
    out.cosmoNamed.push(...(named.meetings ?? []).map((m) => nameOf(m.id)));
  }
  for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
    const r = (await cosmoUpdate({ meetingId: ids[name] }, tc)) as { updated?: boolean };
    if (r.updated) out.cosmoUpdate.push(name);
  }
  for (const k of Object.keys(out)) out[k] = sorted(out[k]);
  return out;
}

/**
 * Every door answers `expected`. Naming a project can only reach meetings
 * under one; Cosmo's update also needs MEETING_UPDATE, which billing admins lack.
 */
function expectEveryDoor(seen: Record<string, string[]>, expected: string[], opts: { canUpdate: boolean }) {
  const want = sorted(expected);
  expect(seen).toEqual({
    list: want, byId: want, attendees: want, invite: want, teams: want, cosmoList: want,
    cosmoNamed: want.filter((n) => n !== "orgLevel"),
    cosmoUpdate: opts.canUpdate ? want : [],
  });
}

describe("every meeting door gives the same meetings", () => {
  it("a member with no policy reads all three everywhere (the positive control)", async () => {
    expectEveryDoor(await doors(actor.control), ["inP", "inOther", "orgLevel"], { canUpdate: true });
  });

  it("a policy on ITEM_READ is about work items: it hides no meeting at any door", async () => {
    expectEveryDoor(await doors(actor.denyItem), ["inP", "inOther", "orgLevel"], { canUpdate: true });
  });

  it("a policy on MEETING_READ for P hides P's meeting at every door, and only it", async () => {
    expectEveryDoor(await doors(actor.denyMeet), ["inOther", "orgLevel"], { canUpdate: true });
  });

  it("a policy on MEETING_READ with no condition hides every meeting at every door, those under no project too", async () => {
    expectEveryDoor(await doors(actor.denyAllMeet), [], { canUpdate: true });
  });

  it("a billing admin granted MEETING_READ reads every meeting everywhere, the list included", async () => {
    expectEveryDoor(await doors(actor.billing), ["inP", "inOther", "orgLevel"], { canUpdate: false });
  });

  it("without MEETING_READ, the meeting doors refuse outright", async () => {
    h.ctx = await loadMemberAuthContext(orgId, actor.billingNoGrant);
    for (const id of Object.values(ids)) {
      expect((await getMeeting(req(), at(id))).status).toBe(403);
      expect((await getInvite(req(), at(id))).status).toBe(403);
      expect((await getTeams(req(), at(id))).status).toBe(403);
    }
    const list = await listMeetings(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/meetings`), { params: Promise.resolve({ orgId }) });
    expect(list.status).toBe(403);
  });
});
