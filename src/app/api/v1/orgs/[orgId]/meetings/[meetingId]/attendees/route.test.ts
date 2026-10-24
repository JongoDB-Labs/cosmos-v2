// @vitest-environment node
//
// Attendees can be sent Outlook invitations (COSMOS-202 B2), so adding one
// takes a member of the meeting's own org: a user id from another org, or
// someone who left, is a 400 and nothing is written.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const ORG_ID = "11111111-1111-4111-a111-111111111111";
const MEETING = "33333333-3333-4333-a333-333333333333";
const ME = "22222222-2222-4222-a222-222222222222";
const MEMBER = "44444444-4444-4444-a444-444444444444";
const STRANGER = "66666666-6666-4666-a666-666666666666";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    syncMeeting: { findFirst: vi.fn() },
    orgMember: { count: vi.fn() },
    meetingAttendee: { create: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", () => ({ syncMeetingSoon: vi.fn() }));

import { POST, PUT } from "./route";

const bits = (...keys: PermissionKey[]) => keys.reduce((acc, k) => acc | Permission[k], 0n);
const params = Promise.resolve({ orgId: ORG_ID, meetingId: MEETING });
const req = (method: string, body: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/o/meetings/${MEETING}/attendees`, { method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue({
    userId: ME, orgId: ORG_ID, orgRole: OrgRole.ADMIN, permissions: bits("MEETING_UPDATE"), basePermissions: bits("MEETING_UPDATE"), abacRules: [],
  });
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.syncMeeting.findFirst.mockResolvedValue({ id: MEETING, meetingType: "STANDUP", meetingDate: new Date() });
  // Only MEMBER is an active member of ORG_ID.
  prisma.orgMember.count.mockImplementation(async ({ where }: { where: { orgId: string; userId: { in: string[] }; removedAt: null } }) =>
    where.orgId === ORG_ID && where.removedAt === null ? where.userId.in.filter((id) => id === MEMBER).length : 0);
  prisma.meetingAttendee.create.mockImplementation(async ({ data }: { data: { userId: string } }) => ({ id: "a1", ...data }));
  prisma.meetingAttendee.upsert.mockResolvedValue({ id: "a1" });
});

describe("meeting attendees: members of the org only", () => {
  it("POST refuses someone outside the org, and adds a member", async () => {
    expect((await POST(req("POST", { userId: STRANGER }), { params })).status).toBe(400);
    expect(prisma.meetingAttendee.create).not.toHaveBeenCalled();
    expect((await POST(req("POST", { userId: MEMBER }), { params })).status).toBe(201);
    // Removed members don't count: the check asks for active memberships.
    expect(prisma.orgMember.count).toHaveBeenCalledWith({ where: { orgId: ORG_ID, userId: { in: [MEMBER] }, removedAt: null } });
  });

  it("PUT refuses the whole update if any one attendee is outside the org", async () => {
    expect((await PUT(req("PUT", { attendees: [{ userId: MEMBER }, { userId: STRANGER }] }), { params })).status).toBe(400);
    expect(prisma.meetingAttendee.upsert).not.toHaveBeenCalled();
  });
});
