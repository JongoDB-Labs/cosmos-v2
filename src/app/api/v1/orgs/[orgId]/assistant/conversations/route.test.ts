import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, getAuthContext } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    assistantConversation: { findMany: vi.fn(), create: vi.fn() },
  },
  getAuthContext: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ orgId: ORG });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "o" });
  getAuthContext.mockResolvedValue({
    userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions: Permission.CHAT_USE, basePermissions: Permission.CHAT_USE, abacRules: [],
  } satisfies AuthContext);
  prisma.assistantConversation.findMany.mockResolvedValue([]);
  prisma.assistantConversation.create.mockResolvedValue({ id: "c1" });
});

const get = (qs = "") => new NextRequest(`http://localhost/api/v1/orgs/o/assistant/conversations${qs}`);
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/orgs/o/assistant/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the conversation list", () => {
  it("leaves archived conversations out, so archiving sticks", async () => {
    await GET(get(), { params });
    expect(prisma.assistantConversation.findMany.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      userId: ME,
      archived: false,
    });
  });

  it("includes them when asked", async () => {
    await GET(get("?archived=true"), { params });
    expect(prisma.assistantConversation.findMany.mock.calls[0][0].where).toEqual({ orgId: ORG, userId: ME });
  });
});

describe("creating a conversation", () => {
  it("can create one already archived (out of the list)", async () => {
    await POST(post({ title: "Tour: Step", archived: true }), { params });
    expect(prisma.assistantConversation.create.mock.calls[0][0].data).toEqual({
      orgId: ORG, userId: ME, title: "Tour: Step", archived: true,
    });
  });

  it("leaves archived to its default otherwise", async () => {
    await POST(post({ title: "Plain" }), { params });
    expect(prisma.assistantConversation.create.mock.calls[0][0].data).toEqual({ orgId: ORG, userId: ME, title: "Plain" });
  });
});
