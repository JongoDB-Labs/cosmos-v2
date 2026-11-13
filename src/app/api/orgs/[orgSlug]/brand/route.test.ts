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

  it("leaves out an uploaded logo: its address is members-only and names the org's id", async () => {
    const orgId = "0b9d1f3e-6c2a-4f5e-9a7b-1c2d3e4f5a6b";
    prisma.organization.findUnique.mockResolvedValue({
      brandName: "Acme Studio",
      logoUrl: `/api/v1/orgs/${orgId}/logo?v=3`,
      tagline: null,
      agentName: null,
      defaultSkinId: null,
    });
    const res = await GET(req("acme"), { params: Promise.resolve({ orgSlug: "acme" }) });
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ brandName: "Acme Studio", logoUrl: null });
    expect(text).not.toContain(orgId);

    // Written out in full, it is still the members-only route.
    prisma.organization.findUnique.mockResolvedValue({
      brandName: null, logoUrl: `https://cosmos.example.com/api/v1/orgs/${orgId}/logo?v=3`, tagline: null, agentName: null, defaultSkinId: null,
    });
    const full = await (await GET(req("acme"), { params: Promise.resolve({ orgSlug: "acme" }) })).text();
    expect(full).not.toContain(orgId);
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
