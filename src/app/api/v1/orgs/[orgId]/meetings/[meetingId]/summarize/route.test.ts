// @vitest-environment node
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getAuthContext, prisma, requireAccess } = vi.hoisted(() => ({
  getAuthContext: vi.fn(), requireAccess: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() }, syncMeeting: { findFirst: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/abac/require-access", () => ({ requireAccess }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/ai/claude-cli", () => ({
  callClaudeCli: vi.fn().mockResolvedValue({
    content: '{"summary":"Decisions made.","tickets":[{"title":"Ship X","description":"","type":"TASK"}]}',
    toolCalls: [],
  }),
}));

import { POST } from "./route";
const params = Promise.resolve({ orgId: "o", meetingId: "m" });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: "o", slug: "acme" });
  getAuthContext.mockResolvedValue({ userId: "u", orgId: "o" });
  prisma.syncMeeting.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "m", attendees: [], ...data }));
});

it("writes aiSummary + aiTickets from the model output", async () => {
  prisma.syncMeeting.findFirst.mockResolvedValue({ id: "m", createdById: "u", projectId: null, notes: "n", transcript: null, attendees: [] });
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.aiSummary).toBe("Decisions made.");
  expect(data.aiTickets).toHaveLength(1);
});

it("400s when there's nothing to summarize", async () => {
  prisma.syncMeeting.findFirst.mockResolvedValue({ id: "m", createdById: "u", projectId: null, notes: "", transcript: null, attendees: [] });
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(res.status).toBe(400);
});
