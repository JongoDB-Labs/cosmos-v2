// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  publish: vi.fn(),
  prisma: { organization: { findUnique: vi.fn() } },
  loadChannelAndMembership: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma: h.prisma }));
vi.mock("@/lib/realtime/bus", () => ({ getBus: () => ({ publish: h.publish }) }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));
vi.mock("@/lib/chat/access", () => ({
  loadChannelAndMembership: h.loadChannelAndMembership,
  canPostToChannelGiven: () => true,
}));

import { POST } from "./route";

const ORG = "11111111-1111-1111-1111-111111111111";
const CHANNEL = "22222222-2222-2222-2222-222222222222";
const params = Promise.resolve({ orgId: ORG, channelId: CHANNEL });
const req = () => new NextRequest(`http://localhost/api/v1/orgs/${ORG}/chat/channels/${CHANNEL}/typing`, { method: "POST" });
const ctx = (permissions: bigint, key?: string[]) => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.OWNER, permissions, basePermissions: permissions, abacRules: [],
  ...(key ? { isApiKey: true, scopes: key } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme" });
  h.loadChannelAndMembership.mockResolvedValue({ channel: { id: CHANNEL, orgId: ORG }, member: { role: "MEMBER" } });
});

describe("POST typing — a chat write", () => {
  it("an owner's items:write key can't show its owner typing", async () => {
    h.getAuthContext.mockResolvedValue(ctx(scopeMask(["items:write"]), ["items:write"]));
    expect((await POST(req(), { params })).status).toBe(403);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("a member's browser session still does", async () => {
    expect(RolePermissions.MEMBER & Permission.CHAT_USE).toBe(Permission.CHAT_USE);
    h.getAuthContext.mockResolvedValue(ctx(RolePermissions.MEMBER));
    expect((await POST(req(), { params })).status).toBe(200);
    expect(h.publish).toHaveBeenCalledOnce();
  });
});
