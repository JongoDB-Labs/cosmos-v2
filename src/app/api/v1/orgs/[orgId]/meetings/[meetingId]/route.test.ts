// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, requireAccess } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireAccess: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    syncMeeting: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/abac/require-access", () => ({ requireAccess }));

import { PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const MEETING_ID = "22222222-2222-2222-2222-222222222222";
const params = Promise.resolve({ orgId: ORG_ID, meetingId: MEETING_ID });

function ctx(): AuthContext {
  return { userId: "4", orgId: ORG_ID, orgRole: OrgRole.MEMBER,
    permissions: Permission.MEETING_UPDATE, basePermissions: Permission.MEETING_UPDATE, abacRules: [] };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx());
  prisma.syncMeeting.findFirst.mockResolvedValue({ id: MEETING_ID, createdById: "4", projectId: null });
  prisma.syncMeeting.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: MEETING_ID, attendees: [], ...data }));
});

it("derives videoProvider from a pasted Zoom URL", async () => {
  const req = new NextRequest("http://localhost/x", {
    method: "PUT", body: JSON.stringify({ meetingUrl: "https://us02web.zoom.us/j/9" }),
  });
  const res = await PUT(req, { params });
  expect(res.status).toBe(200);
  const updateArg = prisma.syncMeeting.update.mock.calls[0][0];
  expect(updateArg.data.meetingUrl).toBe("https://us02web.zoom.us/j/9");
  expect(updateArg.data.videoProvider).toBe("ZOOM");
});
