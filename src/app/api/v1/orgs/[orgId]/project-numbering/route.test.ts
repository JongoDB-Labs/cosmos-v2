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
    project: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET, PUT } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });
const YY = String(new Date().getUTCFullYear() % 100).padStart(2, "0");
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
    new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/project-numbering`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params },
  );

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({
    id: ORG_ID,
    slug: "acme",
    settings: { projects: { numbering: { pattern: "YY-NNN", namePattern: null } } },
  });
  prisma.project.findMany.mockResolvedValue([{ number: `${YY}-004` }]);
});

describe("/project-numbering", () => {
  it("GET gives a member the standard and the next number, read-only", async () => {
    getAuthContext.mockResolvedValue(as("MEMBER"));
    const res = await GET(new NextRequest("http://localhost/x"), { params });
    expect(await res.json()).toEqual({ pattern: "YY-NNN", namePattern: null, next: `${YY}-005`, canManage: false });
  });

  it("GET with no standard: no next number, and no project scan", async () => {
    getAuthContext.mockResolvedValue(as("MEMBER"));
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", settings: {} });
    const res = await GET(new NextRequest("http://localhost/x"), { params });
    expect((await res.json()).next).toBeNull();
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("PUT is refused for a member", async () => {
    getAuthContext.mockResolvedValue(as("MEMBER"));
    const res = await put({ pattern: "YYYY-NNN" });
    expect(res.status).toBe(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("PUT refuses an unusable pattern with a reason, and writes nothing", async () => {
    getAuthContext.mockResolvedValue(as("ADMIN"));
    const res = await put({ pattern: "YY-" });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/run of N/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("PUT refuses a naming pattern without {name}", async () => {
    getAuthContext.mockResolvedValue(as("ADMIN"));
    const res = await put({ namePattern: "{number}" });
    expect(res.status).toBe(400);
  });

  it("PUT by an admin merges the patch; an empty string turns a field off", async () => {
    getAuthContext.mockResolvedValue(as("ADMIN"));
    prisma.$queryRaw.mockResolvedValue([{ settings: { projects: { numbering: { pattern: null, namePattern: null } } } }]);
    const res = await put({ pattern: "" });
    expect(res.status).toBe(200);
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain(JSON.stringify({ pattern: null }));
    expect(await res.json()).toEqual({ pattern: null, namePattern: null, next: null });
  });
});
