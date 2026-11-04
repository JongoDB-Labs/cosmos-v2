// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    timeOffAllowance: { upsert: vi.fn(), deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { PUT } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ME = "44444444-4444-4444-8444-444444444444";
const PERSON = "55555555-5555-4555-8555-555555555555";
const params = Promise.resolve({ orgId: ORG_ID });
const withPerms = (permissions: bigint): AuthContext => ({
  userId: ME,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions,
  basePermissions: permissions,
  abacRules: [],
});
const put = (body: unknown) =>
  PUT(
    new NextRequest("http://localhost/x", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params },
  );
const MANAGER = Permission.TIME_READ | Permission.TIME_READ_ALL | Permission.TIME_APPROVE;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", settings: {} });
  prisma.orgMember.findUnique.mockResolvedValue({ id: "m1" });
});

describe("PUT /time-off/allowances", () => {
  it("a member can't set anyone's allowance, including their own", async () => {
    getAuthContext.mockResolvedValue(withPerms(RolePermissions.MEMBER));
    const res = await put({ userId: ME, year: 2026, hours: 999 });
    expect(res.status).toBe(403);
    expect(prisma.timeOffAllowance.upsert).not.toHaveBeenCalled();
  });

  it("a supervisor who can approve but not read everyone's time is refused too", async () => {
    getAuthContext.mockResolvedValue(withPerms(Permission.TIME_READ | Permission.TIME_APPROVE));
    expect((await put({ userId: PERSON, year: 2026, hours: 160 })).status).toBe(403);
  });

  it("sets one person's allowance for one year", async () => {
    getAuthContext.mockResolvedValue(withPerms(MANAGER));
    const res = await put({ userId: PERSON, year: 2026, hours: 160 });
    expect(res.status).toBe(200);
    expect(prisma.timeOffAllowance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_userId_year: { orgId: ORG_ID, userId: PERSON, year: 2026 } },
        create: expect.objectContaining({ hours: 160, updatedById: ME }),
      }),
    );
  });

  it("null removes a person's own figure, so the default applies", async () => {
    getAuthContext.mockResolvedValue(withPerms(MANAGER));
    await put({ userId: PERSON, year: 2026, hours: null });
    expect(prisma.timeOffAllowance.deleteMany).toHaveBeenCalledWith({ where: { orgId: ORG_ID, userId: PERSON, year: 2026 } });
    expect(prisma.timeOffAllowance.upsert).not.toHaveBeenCalled();
  });

  it("someone outside the org is a 404", async () => {
    getAuthContext.mockResolvedValue(withPerms(MANAGER));
    prisma.orgMember.findUnique.mockResolvedValue(null);
    expect((await put({ userId: PERSON, year: 2026, hours: 1 })).status).toBe(404);
    expect(prisma.timeOffAllowance.upsert).not.toHaveBeenCalled();
  });

  it("a person's allowance needs a year", async () => {
    getAuthContext.mockResolvedValue(withPerms(MANAGER));
    expect((await put({ userId: PERSON, hours: 1 })).status).toBe(400);
  });

  it("without a person: merges the org default into settings", async () => {
    getAuthContext.mockResolvedValue(withPerms(MANAGER));
    const res = await put({ hours: 120 });
    expect(res.status).toBe(200);
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toContain(JSON.stringify({ annualAllowanceHours: 120 }));
  });
});
