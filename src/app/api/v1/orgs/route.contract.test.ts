// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ userContext: vi.fn(), findUnique: vi.fn() }));
vi.mock("@/lib/openapi/user-context", () => ({ userContext: h.userContext }));
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findUnique: h.findUnique } } }));

import { GET } from "./route";

const membership = (id: string) => ({
  role: "MEMBER", joinedAt: new Date("2026-01-01T00:00:00Z"),
  org: { id, name: id, slug: id, plan: "TEAM", logoUrl: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue({ memberships: [membership("11111111-1111-4111-8111-111111111111")] });
});

describe("GET /orgs", () => {
  it("a session lists every membership", async () => {
    h.userContext.mockResolvedValue({ userId: "u" });
    const res = await GET(new NextRequest("http://localhost/api/v1/orgs"));
    expect(res.status).toBe(200);
    expect(h.findUnique.mock.calls[0][0].include.memberships.where).toBeUndefined();
  });

  it("a token is bound to one org and lists only that one", async () => {
    h.userContext.mockResolvedValue({ userId: "u", token: { orgId: "o-token" } });
    await GET(new NextRequest("http://localhost/api/v1/orgs"));
    expect(h.findUnique.mock.calls[0][0].include.memberships.where).toEqual({ orgId: "o-token" });
  });
});
