// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET, PUT } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });
const as = (role: "MEMBER" | "ADMIN"): AuthContext => ({
  userId: "44444444-4444-4444-8444-444444444444",
  orgId: ORG_ID,
  orgRole: OrgRole[role],
  permissions: RolePermissions[role],
  basePermissions: RolePermissions[role],
  abacRules: [],
});
const put = (body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/time-categories`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params },
  );

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", settings: {} });
});

describe("/time-categories", () => {
  it("GET gives a member the defaults, and says they can't manage them", async () => {
    getAuthContext.mockResolvedValue(as("MEMBER"));
    const res = await GET(new NextRequest("http://localhost/x"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      categories: ["Overhead", "Business development", "Professional development"],
      canManage: false,
    });
  });

  it("PUT is refused for a member, and nothing is written", async () => {
    getAuthContext.mockResolvedValue(as("MEMBER"));
    const res = await put({ categories: ["Admin"] });
    expect(res.status).toBe(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("PUT by an admin writes the normalised list and returns it", async () => {
    getAuthContext.mockResolvedValue(as("ADMIN"));
    prisma.$queryRaw.mockResolvedValue([{ settings: { time: { internalCategories: ["Admin", "Training"] } } }]);
    const res = await put({ categories: [" Admin ", "admin", "", "Training"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: ["Admin", "Training"] });
    // The tagged template's interpolated values: the merged JSON is the normalised list.
    const values = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(JSON.stringify({ internalCategories: ["Admin", "Training"] }));
  });

  it("PUT accepts an empty list (stop categorising)", async () => {
    getAuthContext.mockResolvedValue(as("ADMIN"));
    prisma.$queryRaw.mockResolvedValue([{ settings: { time: { internalCategories: [] } } }]);
    const res = await put({ categories: [] });
    expect(await res.json()).toEqual({ categories: [] });
  });
});
