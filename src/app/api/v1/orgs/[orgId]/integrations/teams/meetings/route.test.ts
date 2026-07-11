// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, scheduleTeamsMeeting, listTeamsMeetings } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
  scheduleTeamsMeeting: vi.fn(),
  listTeamsMeetings: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/integrations/teams-meetings", () => ({ scheduleTeamsMeeting, listTeamsMeetings }));

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function ctx(permissions: bigint): AuthContext {
  return {
    userId: "44444444-4444-4444-4444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/v1/orgs/o/integrations/teams/meetings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
function get(query = "") {
  return new NextRequest(`http://localhost/api/v1/orgs/o/integrations/teams/meetings${query}`);
}

const VALID = {
  organizer: "u1",
  subject: "Sprint sync",
  start: "2026-07-15T10:00:00",
  end: "2026-07-15T10:30:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx(Permission.MEETING_CREATE | Permission.MEETING_READ));
});

describe("POST /integrations/teams/meetings (schedule)", () => {
  it("403 when the caller lacks MEETING_CREATE (no Graph call)", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.MEETING_READ));
    const res = await POST(post(VALID), { params });
    expect(res.status).toBe(403);
    expect(scheduleTeamsMeeting).not.toHaveBeenCalled();
  });

  it("201 with the created meeting on success", async () => {
    scheduleTeamsMeeting.mockResolvedValue({ ok: true, meeting: { id: "evt-1", subject: "Sprint sync" } });
    const res = await POST(post(VALID), { params });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.meeting.id).toBe("evt-1");
    expect(scheduleTeamsMeeting).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ organizer: "u1" }));
  });

  it("409 when the tenant is not linked (graceful not-connected message)", async () => {
    scheduleTeamsMeeting.mockResolvedValue({
      ok: false,
      error: "Microsoft 365 is not connected for this organization.",
    });
    const res = await POST(post(VALID), { params });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/not connected/i);
  });

  it("502 for other Graph errors (e.g. insufficient permission)", async () => {
    scheduleTeamsMeeting.mockResolvedValue({
      ok: false,
      error: "Microsoft Graph API error (HTTP 403): ErrorAccessDenied",
    });
    const res = await POST(post(VALID), { params });
    expect(res.status).toBe(502);
  });

  it("400 on an invalid body (missing subject)", async () => {
    const res = await POST(post({ ...VALID, subject: "" }), { params });
    expect(res.status).toBe(400);
    expect(scheduleTeamsMeeting).not.toHaveBeenCalled();
  });
});

describe("GET /integrations/teams/meetings (list)", () => {
  it("400 when the organizer query param is missing", async () => {
    const res = await GET(get(), { params });
    expect(res.status).toBe(400);
    expect(listTeamsMeetings).not.toHaveBeenCalled();
  });

  it("returns the tenant's meetings for the organizer", async () => {
    listTeamsMeetings.mockResolvedValue({ ok: true, meetings: [{ id: "evt-1" }] });
    const res = await GET(get("?organizer=u1"), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.meetings).toHaveLength(1);
    expect(listTeamsMeetings).toHaveBeenCalledWith(ORG_ID, { organizer: "u1", top: undefined });
  });
});
