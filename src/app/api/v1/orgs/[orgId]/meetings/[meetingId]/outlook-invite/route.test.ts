// @vitest-environment node
//
// COSMOS-202 B2 invite mode: invitations go out from a person's own mailbox,
// so an API key can neither read nor change them (403), and a meeting is found
// only within the org in the URL: another org's meeting id is a 404, and
// nothing is read or sent for it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG_ID = "11111111-1111-4111-a111-111111111111";
const OTHER_ORG = "55555555-5555-4555-a555-555555555555";
const MEETING = "33333333-3333-4333-a333-333333333333";
const ME = "22222222-2222-4222-a222-222222222222";

const { getAuthContext, prisma, invitePreview, setMeetingInvite } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    syncMeeting: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  invitePreview: vi.fn(),
  setMeetingInvite: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", () => ({
  InviteRefused: class extends Error {},
  invitePreview,
  setMeetingInvite,
}));

import { GET, PUT } from "./route";

const bits = (...keys: PermissionKey[]) => keys.reduce((acc, k) => acc | Permission[k], 0n);
const person = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: ME, orgId: ORG_ID, orgRole: OrgRole.ADMIN,
  permissions: bits("MEETING_READ", "MEETING_UPDATE"), basePermissions: bits("MEETING_READ", "MEETING_UPDATE"), abacRules: [],
  ...over,
});
const params = (orgId = ORG_ID) => Promise.resolve({ orgId, meetingId: MEETING });
const get = () => new NextRequest(`http://localhost/api/v1/orgs/o/meetings/${MEETING}/outlook-invite`);
const put = (enabled: boolean) =>
  new NextRequest(`http://localhost/api/v1/orgs/o/meetings/${MEETING}/outlook-invite`, { method: "PUT", body: JSON.stringify({ enabled }) });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, slug: where.id === ORG_ID ? "acme" : "other" }));
  // The meeting belongs to ORG_ID only.
  prisma.syncMeeting.findFirst.mockImplementation(async ({ where }: { where: { id: string; orgId: string } }) =>
    where.id === MEETING && where.orgId === ORG_ID ? { id: MEETING } : null);
  prisma.user.findUnique.mockResolvedValue(null);
  invitePreview.mockResolvedValue({ on: false, organizerId: null, recipients: [] });
  setMeetingInvite.mockResolvedValue(undefined);
});

describe("outlook-invite route", () => {
  it("an API key gets 403 for both reading and changing, and nothing is sent", async () => {
    getAuthContext.mockResolvedValue(person({ isApiKey: true }));
    expect((await GET(get(), { params: params() })).status).toBe(403);
    expect((await PUT(put(true), { params: params() })).status).toBe(403);
    expect(invitePreview).not.toHaveBeenCalled();
    expect(setMeetingInvite).not.toHaveBeenCalled();
  });

  it("another org's meeting id is a 404, read or written, even for an admin of the org in the URL", async () => {
    getAuthContext.mockResolvedValue(person({ orgId: OTHER_ORG }));
    expect((await GET(get(), { params: params(OTHER_ORG) })).status).toBe(404);
    expect((await PUT(put(true), { params: params(OTHER_ORG) })).status).toBe(404);
    expect(prisma.syncMeeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: MEETING, orgId: OTHER_ORG } }));
    expect(invitePreview).not.toHaveBeenCalled();
    expect(setMeetingInvite).not.toHaveBeenCalled();
  });

  it("a person in the meeting's org gets through to the invitation logic", async () => {
    getAuthContext.mockResolvedValue(person());
    expect((await PUT(put(true), { params: params() })).status).toBe(200);
    expect(setMeetingInvite).toHaveBeenCalledWith(ORG_ID, MEETING, ME, true);
  });
});
