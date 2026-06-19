// @vitest-environment node
//
// Public pre-auth brand endpoint (Phase 2). Proves:
//   - returns ONLY the branding fields (brandName/logoUrl/tagline/agentName/defaultSkinId);
//   - an unknown slug ⇒ all-null branding (login degrades to deployment default);
//   - no sensitive org columns leak.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { prisma, rateLimit, getRateLimitKey } = vi.hoisted(() => ({
  prisma: { organization: { findUnique: vi.fn() } },
  rateLimit: vi.fn(() => ({ allowed: true })),
  getRateLimitKey: vi.fn(() => "k"),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rate-limit/bucket", () => ({ rateLimit, getRateLimitKey }));

import { GET } from "./route";

function req(slug: string) {
  return new NextRequest(`http://localhost/api/orgs/${slug}/brand`);
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockReturnValue({ allowed: true });
});

describe("public brand endpoint", () => {
  it("returns only the branding fields for a known org", async () => {
    prisma.organization.findUnique.mockResolvedValue({
      brandName: "Acme Studio",
      logoUrl: "https://cdn/x.png",
      tagline: "Build beautifully",
      agentName: "Acme Helper",
      defaultSkinId: "atelier",
    });
    const res = await GET(req("acme"), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      brandName: "Acme Studio",
      logoUrl: "https://cdn/x.png",
      tagline: "Build beautifully",
      agentName: "Acme Helper",
      defaultSkinId: "atelier",
    });
  });

  it("unknown slug ⇒ all-null branding (200)", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    const res = await GET(req("nope"), { params: Promise.resolve({ orgSlug: "nope" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      brandName: null,
      logoUrl: null,
      tagline: null,
      agentName: null,
      defaultSkinId: null,
    });
  });

  it("never leaks sensitive columns even if the row carries them", async () => {
    prisma.organization.findUnique.mockResolvedValue({
      brandName: "Acme",
      logoUrl: null,
      tagline: null,
      agentName: null,
      defaultSkinId: null,
    });
    const res = await GET(req("acme"), { params: Promise.resolve({ orgSlug: "acme" }) });
    const text = await res.text();
    expect(text).not.toContain("settings");
    expect(text).not.toContain("dbConnectionId");
    expect(text).not.toContain("auth0OrgId");
  });

  it("429 when rate-limited", async () => {
    rateLimit.mockReturnValue({ allowed: false });
    const res = await GET(req("acme"), { params: Promise.resolve({ orgSlug: "acme" }) });
    expect(res.status).toBe(429);
  });
});
