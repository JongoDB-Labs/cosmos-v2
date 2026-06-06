// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext, prisma, getMeetClient, requireAccess } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireAccess: vi.fn(),
  getMeetClient: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() }, syncMeeting: { findFirst: vi.fn(), update: vi.fn() } },
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
  prisma.syncMeeting.findFirst.mockResolvedValue({ id: "m", createdById: "u", projectId: null });
  prisma.syncMeeting.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "m", attendees: [], ...data }));
});

it("creates a Meet space and stores the join URL + space name", async () => {
  getMeetClient.mockResolvedValue({
    spaces: { create: vi.fn().mockResolvedValue({ data: { name: "spaces/abc", meetingUri: "https://meet.google.com/x-y-z" } }) },
  });
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.meetingUrl).toBe("https://meet.google.com/x-y-z");
  expect(data.meetSpaceName).toBe("spaces/abc");
  expect(data.videoProvider).toBe("GOOGLE_MEET");
});

it("returns 409 with a reconnect hint when Meet access is missing", async () => {
  getMeetClient.mockRejectedValue(new Error("no refresh token"));
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(res.status).toBe(409);
});
