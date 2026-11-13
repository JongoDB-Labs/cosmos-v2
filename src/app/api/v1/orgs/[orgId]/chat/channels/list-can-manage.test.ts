// @vitest-environment node
//
// The channel list's `canManage` flag follows the same rule as the routes
// (#1130): a channel ADMIN's or org admin's role counts only for a browser
// session or a key whose scopes grant CHAT_USE, which none do. The list itself
// now refuses such a key, as every chat route does, so it never sees the flag.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG = "11111111-1111-4111-8111-111111111111";
const h = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: "11111111-1111-4111-8111-111111111111", slug: "acme" }) },
    chatChannelMember: {
      // The caller created this channel, so they are its ADMIN.
      findMany: async () => [{
        role: "ADMIN",
        channel: {
          id: "ch1", kind: "CHANNEL", name: "c", slug: "c", description: null, topic: null,
          isPrivate: false, isGeneral: false, projectId: null, dmKey: null, lastMessageAt: null, members: [],
        },
      }],
    },
    user: { findMany: async () => [] },
  },
}));

import { GET } from "./route";

const as = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.OWNER,
  permissions: Permission.ORG_READ | Permission.CHAT_USE, basePermissions: Permission.ORG_READ | Permission.CHAT_USE,
  abacRules: [], ...over,
});
const list = async () => {
  const res = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId: ORG }) });
  expect(res.status).toBe(200);
  return (await res.json()).channels as { canManage: boolean }[];
};

beforeEach(() => vi.clearAllMocks());

describe("channel list canManage", () => {
  it("is never offered to a key, even its creator's (channel ADMIN) and an owner's: the list refuses it", async () => {
    h.getAuthContext.mockResolvedValue(as({ isApiKey: true, scopes: ["read", "items:write"], permissions: Permission.ORG_READ }));
    const res = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId: ORG }) });
    expect(res.status).toBe(403);
  });

  it("is true for the channel ADMIN's browser session", async () => {
    h.getAuthContext.mockResolvedValue(as({ orgRole: OrgRole.MEMBER }));
    expect((await list())[0].canManage).toBe(true);
  });
});
