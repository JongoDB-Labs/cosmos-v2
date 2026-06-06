// @vitest-environment node
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext, prisma, getMeetClient, requireAccess } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireAccess: vi.fn(),
  getMeetClient: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    syncMeeting: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/abac/require-access", () => ({ requireAccess }));
vi.mock("@/lib/integrations/google", () => ({ getMeetClient }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { POST } from "./route";
const params = Promise.resolve({ orgId: "o", meetingId: "m" });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: "o", slug: "acme" });
  getAuthContext.mockResolvedValue({ userId: "u", orgId: "o" });
});

it("400s when the meeting has no Meet space", async () => {
  prisma.syncMeeting.findFirst.mockResolvedValue({
    id: "m",
    createdById: "u",
    projectId: null,
    meetSpaceName: null,
    transcript: null,
  });
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(res.status).toBe(400);
});

it("returns ready:false when no conference record exists yet", async () => {
  prisma.syncMeeting.findFirst.mockResolvedValue({
    id: "m",
    createdById: "u",
    projectId: null,
    meetSpaceName: "spaces/abc",
    transcript: null,
  });
  getMeetClient.mockResolvedValue({
    conferenceRecords: {
      list: vi.fn().mockResolvedValue({ data: { conferenceRecords: [] } }),
    },
  });
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(res.status).toBe(200);
  expect((await res.json()).ready).toBe(false);
});
