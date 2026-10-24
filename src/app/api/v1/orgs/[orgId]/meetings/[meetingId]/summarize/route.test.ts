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
vi.mock("@/lib/ai/agent-loop", () => ({
  runAgentLoop: vi.fn().mockResolvedValue({
    text: '{"summary":"Decisions made.","tickets":[{"title":"Ship X","description":"","type":"TASK"}]}',
    toolCalls: [],
  }),
}));

import { POST } from "./route";
import { runAgentLoop } from "@/lib/ai/agent-loop";
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

// The loop still appends the org's connector tools even with `tools: []`, so
// it must run under the caller's own context — an API key's narrowed one when
// that is who called — never one rebuilt from the user id.
it("runs the agent loop with the caller's own AuthContext", async () => {
  const keyCtx = { userId: "u", orgId: "o", orgRole: "OWNER", permissions: 1n, isApiKey: true, projectScope: ["p"] };
  getAuthContext.mockResolvedValue(keyCtx);
  prisma.syncMeeting.findFirst.mockResolvedValue({ id: "m", createdById: "u", projectId: null, notes: "n", transcript: null, attendees: [] });
  await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params });
  expect(vi.mocked(runAgentLoop).mock.calls[0][0].auth).toBe(keyCtx);
});
