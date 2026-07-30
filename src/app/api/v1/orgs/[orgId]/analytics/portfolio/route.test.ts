// @vitest-environment node
//
// Portfolio analytics is another INDEX over projects, and it leaked the same
// way the projects list did: it returned every project's name, key and progress
// metrics on the ANALYTICS_READ bit alone, with no regard for teamScopedAccess.
//
// Found by asking "where else can a project be observed?" rather than "where
// else does the old gate pattern appear" — the pattern search that produced the
// original conversion could not find this, because this route never used the
// pattern.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
    board: { findMany: vi.fn() },
    workItem: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    interval: { findFirst: vi.fn(), findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OPEN = "22222222-2222-4222-8222-222222222222";
const RESTRICTED = "33333333-3333-4333-8333-333333333333";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  const perms = Permission.ANALYTICS_READ | Permission.PROJECT_READ;
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
    ...over,
  };
}

const params = Promise.resolve({ orgId: ORG_ID });
const req = () => new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/analytics/portfolio`);

async function names(res: Response): Promise<string[]> {
  const body = await res.json();
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows.map((p: { projectName?: string; name?: string }) => p.projectName ?? p.name ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findMany.mockResolvedValue([
    { id: OPEN, name: "Open", key: "OPN", teamScopedAccess: false },
    { id: RESTRICTED, name: "Secret", key: "SEC", teamScopedAccess: true },
  ]);
  prisma.board.findMany.mockResolvedValue([]);
  prisma.workItem.findMany.mockResolvedValue([]);
  prisma.workItem.count.mockResolvedValue(0);
  prisma.workItem.groupBy.mockResolvedValue([]);
  prisma.interval.findFirst.mockResolvedValue(null);
  prisma.interval.findMany.mockResolvedValue([]);
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findMany.mockResolvedValue([]);
  prisma.projectMember.findFirst.mockResolvedValue(null);
});

describe("portfolio analytics — team-scoped projects", () => {
  it("omits a restricted project from the rollup for a non-member", async () => {
    getAuthContext.mockResolvedValue(ctx());
    const out = await names(await GET(req(), { params }));
    expect(out).toContain("Open");
    expect(out).not.toContain("Secret");
  });

  it("includes it for a member of that project", async () => {
    prisma.projectMember.findMany.mockResolvedValue([{ projectId: RESTRICTED }]);
    getAuthContext.mockResolvedValue(ctx());
    const out = await names(await GET(req(), { params }));
    expect(out).toEqual(expect.arrayContaining(["Open", "Secret"]));
  });

  it("includes it for the org OWNER", async () => {
    getAuthContext.mockResolvedValue(ctx({ orgRole: OrgRole.OWNER }));
    expect(await names(await GET(req(), { params }))).toContain("Secret");
  });

  it("leaves an org with nothing restricted unchanged", async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: OPEN, name: "Open", key: "OPN", teamScopedAccess: false },
    ]);
    getAuthContext.mockResolvedValue(ctx());
    expect(await names(await GET(req(), { params }))).toEqual(["Open"]);
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });
});
