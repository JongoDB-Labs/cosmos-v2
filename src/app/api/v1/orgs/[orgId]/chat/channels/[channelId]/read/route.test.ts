// @vitest-environment node
//
// Marking a channel read broadcasts a read receipt to the channel. The member
// update silently no-op'd for someone who isn't in the channel, and the
// receipt went out anyway, putting a non-member's avatar in the channel. A
// non-member now gets a 404 and nothing is broadcast.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const ORG = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), publish: vi.fn(), memberRows: 1 }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/realtime/bus", () => ({ getBus: () => ({ publish: h.publish }) }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme" }) },
    chatChannel: { findUnique: async () => ({ orgId: ORG }) },
    chatChannelMember: { updateMany: async () => ({ count: h.memberRows }) },
  },
}));

import { POST } from "./route";

const markRead = () =>
  POST(
    new NextRequest("http://localhost/x", {
      method: "POST", body: JSON.stringify({ messageId: MESSAGE }), headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ orgId: ORG, channelId: CHANNEL }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getAuthContext.mockResolvedValue({
    userId: "u1", orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER, abacRules: [],
  });
});

describe("POST read — only a member's read position", () => {
  it("a member marks the channel read, and the receipt goes out", async () => {
    h.memberRows = 1;
    expect((await markRead()).status).toBe(200);
    expect(h.publish).toHaveBeenCalledWith(expect.anything(), "chat.read.receipt", expect.objectContaining({ userId: "u1" }));
  });

  it("a non-member gets a 404 and nothing is broadcast", async () => {
    h.memberRows = 0;
    expect((await markRead()).status).toBe(404);
    expect(h.publish).not.toHaveBeenCalled();
  });
});
