// @vitest-environment node
//
// COSMOS-202 T2: a person's own Teams notification choices. Never on an API key
// (it would be the key owner's chat), only with NOTIFICATION_READ, only their
// own conversation, and nothing to choose until the bot has a chat with them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG_ID = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";

const { getAuthContext, prisma, teamsAppEnabled } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    teamsConversation: { findUnique: vi.fn(), update: vi.fn() },
  },
  teamsAppEnabled: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/integrations/microsoft/teams-app/identity.server", () => ({ teamsAppEnabled }));

import { GET, PUT } from "./route";

const bits = (...keys: PermissionKey[]) => keys.reduce((acc, k) => acc | Permission[k], 0n);
const person = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: ME, orgId: ORG_ID, orgRole: OrgRole.MEMBER,
  permissions: bits("NOTIFICATION_READ"), basePermissions: bits("NOTIFICATION_READ"), abacRules: [], ...over,
});
const params = Promise.resolve({ orgId: ORG_ID });
const url = "http://localhost/api/v1/orgs/o/microsoft/teams-app/notifications";
const put = (notifyTypes: string[]) => new NextRequest(url, { method: "PUT", body: JSON.stringify({ notifyTypes }) });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  teamsAppEnabled.mockResolvedValue(true);
  prisma.teamsConversation.findUnique.mockResolvedValue({ notifyTypes: ["assigned"] });
  prisma.teamsConversation.update.mockResolvedValue({});
});

describe("Teams notification choices route", () => {
  it("an API key gets 403 and nothing is read or written", async () => {
    getAuthContext.mockResolvedValue(person({ isApiKey: true }));
    expect((await GET(new NextRequest(url), { params })).status).toBe(403);
    expect((await PUT(put(["assigned"]), { params })).status).toBe(403);
    expect(prisma.teamsConversation.findUnique).not.toHaveBeenCalled();
    expect(prisma.teamsConversation.update).not.toHaveBeenCalled();
  });

  it("someone without NOTIFICATION_READ gets 403", async () => {
    getAuthContext.mockResolvedValue(person({ permissions: 0n, basePermissions: 0n }));
    expect((await PUT(put(["assigned"]), { params })).status).toBe(403);
    expect(prisma.teamsConversation.update).not.toHaveBeenCalled();
  });

  it("writes only the signed-in person's own conversation, de-duplicated", async () => {
    getAuthContext.mockResolvedValue(person());
    expect((await PUT(put(["mentioned", "mentioned", "assigned"]), { params })).status).toBe(200);
    expect(prisma.teamsConversation.update).toHaveBeenCalledWith({
      where: { orgId_userId: { orgId: ORG_ID, userId: ME } },
      data: { notifyTypes: ["mentioned", "assigned"] },
    });
  });

  it("409 before the bot has a chat with them; an unknown type is a 400", async () => {
    getAuthContext.mockResolvedValue(person());
    prisma.teamsConversation.findUnique.mockResolvedValue(null);
    expect((await PUT(put(["assigned"]), { params })).status).toBe(409);
    expect((await PUT(put(["everything"]), { params })).status).toBe(400);
    expect(prisma.teamsConversation.update).not.toHaveBeenCalled();
  });
});
