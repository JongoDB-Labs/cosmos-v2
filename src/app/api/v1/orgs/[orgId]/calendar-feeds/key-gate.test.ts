// @vitest-environment node
//
// A calendar feed link is an unauthenticated .ics URL of its owner's items,
// meetings and sprints. It ignores a key's projectScope and keeps working after
// the key is revoked, and creating one checked no permission bit: any key could
// mint a public link to its owner's org data. Creating or changing a link is
// now browser-only; revoking one stays open to a key.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { readFeedOptions } from "@/lib/calendar/feed-settings";

const ORG = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), writes: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/calendar/feed-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/calendar/feed-settings")>()),
  calendarFeedsEnabled: () => true,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: async () => ({ id: ORG, slug: "acme", settings: {} }) },
    calendarFeed: {
      count: async () => 0,
      findFirst: async () => ({ id: "f1" }),
      create: async () => { h.writes.push("calendarFeed.create"); return { id: "f1", options: {}, createdAt: new Date(), lastFetchedAt: null }; },
      update: async () => { h.writes.push("calendarFeed.update"); return { id: "f1", options: {}, createdAt: new Date(), lastFetchedAt: null }; },
    },
  },
}));

import { POST as createFeed } from "./route";
import { PATCH as changeFeed, DELETE as revokeFeed } from "./[feedId]/route";

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
const as = (permissions: bigint, scopes?: string[]): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.OWNER, permissions, basePermissions: permissions, abacRules: [],
  ...(scopes ? { isApiKey: true, scopes } : {}),
});
const orgParams = { params: Promise.resolve({ orgId: ORG }) };
const feedParams = { params: Promise.resolve({ orgId: ORG, feedId: "f1" }) };

beforeEach(() => { vi.clearAllMocks(); h.writes.length = 0; });

describe("calendar feed links are made in the browser", () => {
  it.each([["read"], ["rules:run"], ["items:write"]])("a key scoped %s can't create one", async (scope) => {
    h.getAuthContext.mockResolvedValue(as(scopeMask([scope]), [scope]));
    expect((await createFeed(req("POST", {}), orgParams)).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a key can't change an existing link's options", async () => {
    h.getAuthContext.mockResolvedValue(as(scopeMask(["items:write"]), ["items:write"]));
    expect((await changeFeed(req("PATCH", { options: readFeedOptions({}) }), feedParams)).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a key can still revoke one", async () => {
    h.getAuthContext.mockResolvedValue(as(scopeMask(["read"]), ["read"]));
    expect((await revokeFeed(req("DELETE"), feedParams)).status).toBe(204);
    expect(h.writes).toEqual(["calendarFeed.update"]);
  });

  it("a member's browser session still creates and changes one", async () => {
    h.getAuthContext.mockResolvedValue({ ...as(Permission.ORG_READ), orgRole: OrgRole.MEMBER });
    expect((await createFeed(req("POST", {}), orgParams)).status).toBe(201);
    expect((await changeFeed(req("PATCH", { options: readFeedOptions({}) }), feedParams)).status).toBe(200);
    expect(h.writes).toEqual(["calendarFeed.create", "calendarFeed.update"]);
  });
});
