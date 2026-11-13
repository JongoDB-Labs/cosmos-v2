// @vitest-environment node
//
// The Teams meeting routes: creating a meeting as a Teams meeting, and a
// meeting's Teams state and toggle. A Teams meeting is made in the caller's
// own Outlook, so neither ever runs on an API key, and a refusal comes before
// anything is saved. The join link follows the meeting's visibility.
// Through the real routes, against a real database; Graph is never reached
// (the push after a save is stubbed: the sync has its own tests).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { apiKeyAuthContext } from "@/lib/auth/api-key";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { MS_CALENDAR } from "@/lib/integrations/microsoft/calendar-connect";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ enabled: true, clientId: "client-id", clientSecret: "client-secret", tenant: null }),
}));
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/microsoft/calendar-sync.server")>()),
  syncMeetingSoon: vi.fn(),
}));

import { POST as createMeeting } from "./route";
import { GET as getTeams, PUT as setTeams } from "./[meetingId]/teams/route";
import { GET as getInvite, PUT as setInvite } from "./[meetingId]/outlook-invite/route";

const stamp = Math.random().toString(36).slice(2, 8);
const TENANT = "11111111-2222-3333-4444-555555555555";
let orgId = "", restricted = "", outsider = "", insider = "", hidden = "";
const JOIN = `https://teams.microsoft.com/l/meetup-join/routes-${stamp}`;

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@mtr.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@mtr.test`, displayName: "Insider" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `mtr ${stamp}`, slug: `mtr-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId, userId: insider, role: "ADMIN", permissions: "0" } });
  restricted = (await prisma.project.create({ data: { orgId, name: "R", key: `TR${stamp.slice(0, 3).toUpperCase()}`, teamScopedAccess: true } })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
  hidden = (await prisma.syncMeeting.create({
    data: { orgId, projectId: restricted, title: "hidden", meetingDate: new Date(), createdById: insider, teamsHostId: insider, teamsJoinUrl: JOIN },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${stamp}@mtr.test` } } }).catch(() => undefined);
});

const member = (userId: string, extra: Partial<AuthContext> = {}): AuthContext =>
  ({ userId, orgId, orgRole: "MEMBER", abacRules: [], permissions: -1n, basePermissions: -1n, ...extra });
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method, ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const at = (meetingId?: string) => ({ params: Promise.resolve({ orgId, ...(meetingId ? { meetingId } : {}) }) as never });
const titled = (title: string) => prisma.syncMeeting.count({ where: { orgId, title } });
/** A real key with every scope, minted by the insider: no scope carries a meeting permission. */
const widestKey = async () => (await apiKeyAuthContext(orgId, { createdById: insider, scopes: [...API_KEY_SCOPES], projectIds: null, createdAt: new Date() }))!;

async function outlookOn() {
  if (await prisma.integration.count({ where: { orgId, provider: MS_CALENDAR } })) return;
  await prisma.integration.create({
    data: { orgId, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: insider },
  });
}
async function connect(userId: string) {
  await prisma.connectorCredential.create({
    data: { orgId, provider: MS_CALENDAR, userId, secretEnc: "unused", meta: { tid: TENANT, oid: userId, upn: `${userId}@mtr.test`, scopes: [], status: "connected", connectedAt: new Date().toISOString() } },
  });
}

describe("a meeting's Teams state", () => {
  beforeEach(() => void (h.ctx = member(insider)));

  it("is not found for someone who can't see the meeting, exactly as a missing one, and carries no link", async () => {
    h.ctx = member(outsider);
    const missing = await getTeams(json("GET"), at("00000000-0000-4000-8000-000000000000"));
    const res = await getTeams(json("GET"), at(hidden));
    expect([res.status, await res.text()]).toEqual([missing.status, await missing.text()]);
    expect((await setTeams(json("PUT", { enabled: false }), at(hidden))).status).toBe(404);
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: hidden } })).teamsHostId).toBe(insider);
  });

  it("shows the team its join link and host (the positive control)", async () => {
    const res = await getTeams(json("GET"), at(hidden));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ on: true, joinUrl: JOIN, isHost: true, hostName: "Insider", status: "ready" });
  });

  it("never answers an API key", async () => {
    h.ctx = await widestKey();
    expect((await getTeams(json("GET"), at(hidden))).status).toBe(403);
    expect((await setTeams(json("PUT", { enabled: false }), at(hidden))).status).toBe(403);
  });
});

describe("creating a Teams meeting", () => {
  const create = (title: string, teamsMeeting?: boolean) =>
    createMeeting(json("POST", { title, meetingDate: "2026-12-01T10:00:00.000Z", ...(teamsMeeting !== undefined && { teamsMeeting }) }), at());

  it("is refused before anything is saved without Outlook Calendar, and says why", async () => {
    h.ctx = member(insider);
    const res = await create(`no-outlook-${stamp}`, true);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "not_available" });
    expect(await titled(`no-outlook-${stamp}`)).toBe(0);
    // The same meeting without Teams is made as always.
    expect((await create(`plain-${stamp}`)).status).toBe(201);
    expect(await titled(`plain-${stamp}`)).toBe(1);
  });

  it("is refused for someone whose Outlook isn't connected", async () => {
    await outlookOn();
    h.ctx = member(outsider);
    const res = await create(`not-connected-${stamp}`, true);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "not_connected" });
    expect(await titled(`not-connected-${stamp}`)).toBe(0);
  });

  it("is never made on an API key", async () => {
    await outlookOn();
    h.ctx = await widestKey();
    expect((await create(`key-${stamp}`, true)).status).toBe(403);
    expect(await titled(`key-${stamp}`)).toBe(0);
  });

  it("makes the creator the host when they're connected", async () => {
    await outlookOn();
    await connect(insider);
    h.ctx = member(insider);
    const res = await create(`teams-${stamp}`, true);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ teamsHostId: insider, teamsJoinUrl: null });
  });

  it("a refused toggle answers with its reason", async () => {
    await outlookOn();
    h.ctx = member(insider);
    const cancelled = await prisma.syncMeeting.create({ data: { orgId, title: "c", meetingDate: new Date(), createdById: insider, status: "CANCELLED" } });
    const res = await setTeams(json("PUT", { enabled: true }), at(cancelled.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "cancelled", error: "This meeting is cancelled." });
    expect((await prisma.syncMeeting.findUniqueOrThrow({ where: { id: cancelled.id } })).teamsHostId).toBeNull();
  });
});

describe("turning on Outlook invitations while someone else hosts Teams", () => {
  // Invitations would have to carry the Teams meeting, which would end the
  // host's. So it is refused, and the refusal names who to ask.
  const ASK = "Insider hosts this meeting's Teams link. Ask them to turn on invitations, or turn Teams off first.";
  let second = "";
  const meeting = async (teamsHostId: string | null) =>
    (await prisma.syncMeeting.create({
      data: { orgId, title: `inv-${stamp}`, meetingDate: new Date(Date.now() + 86_400_000), createdById: insider, teamsHostId, ...(teamsHostId && { teamsJoinUrl: JOIN }) },
    })).id;

  beforeAll(async () => {
    await outlookOn();
    second = (await prisma.user.create({ data: { email: `second-${stamp}@mtr.test`, displayName: "Second" } })).id;
    await prisma.orgMember.create({ data: { orgId, userId: second, role: "ADMIN", permissions: "0" } });
    await connect(second);
  });
  beforeEach(() => void (h.ctx = member(second, { orgRole: "ADMIN" })));

  it("a meeting nobody hosts on Teams can be turned on (the positive control)", async () => {
    const res = await getInvite(json("GET"), at(await meeting(null)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: null, canChange: true });
  });

  it("says who hosts it before anyone tries", async () => {
    const res = await getInvite(json("GET"), at(await meeting(insider)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: "teams_hosted_by_someone_else", teamsHostId: insider, teamsHostName: "Insider", canChange: false });
  });

  it("is refused with 409, names the host, and leaves their Teams meeting alone", async () => {
    const id = await meeting(insider);
    const res = await setInvite(json("PUT", { enabled: true }), at(id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: ASK, reason: "teams_hosted_by_someone_else" });
    expect(await prisma.syncMeeting.findUniqueOrThrow({ where: { id }, select: { teamsHostId: true, teamsJoinUrl: true, inviteOrganizerId: true } }))
      .toEqual({ teamsHostId: insider, teamsJoinUrl: JOIN, inviteOrganizerId: null });
  });
});
