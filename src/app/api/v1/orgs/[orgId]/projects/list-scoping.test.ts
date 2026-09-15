// @vitest-environment node
//
// The projects LIST must honour teamScopedAccess too.
//
// The read-gate conversion covered projects/[projectId]/**, which is every
// route that reads a project's CONTENTS. It did not cover the list, which sits
// one level up — so a restricted project still appeared as a card, and only
// 403'd once opened. That leaks its existence, name, key and counts to exactly
// the people it is meant to be hidden from, which is most of the value of
// hiding it.
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
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.PROJECT_READ,
    basePermissions: Permission.PROJECT_READ,
    abacRules: [],
    ...over,
  };
}

const params = Promise.resolve({ orgId: ORG_ID });
const listReq = () => new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/projects`);

async function listedIds(res: Response): Promise<string[]> {
  const body = await res.json();
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows.map((p: { id: string }) => p.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // The org has one ordinary project and one limited to its members.
  prisma.project.findMany.mockImplementation(() => {
    const rows = [
      { id: OPEN, orgId: ORG_ID, teamScopedAccess: false, name: "Open", key: "OPN", _count: {} },
      { id: RESTRICTED, orgId: ORG_ID, teamScopedAccess: true, name: "Secret", key: "SEC", _count: {} },
    ];
    return Promise.resolve(rows);
  });
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findMany.mockResolvedValue([]); // a member of nothing
  prisma.projectMember.findFirst.mockResolvedValue(null);
});

describe("GET projects — team-scoped projects stay out of the list", () => {
  it("hides a restricted project from a non-member", async () => {
    getAuthContext.mockResolvedValue(ctx());
    const ids = await listedIds(await GET(listReq(), { params }));
    expect(ids).toContain(OPEN);
    expect(ids).not.toContain(RESTRICTED);
  });

  it("shows it to a member of that project", async () => {
    prisma.projectMember.findMany.mockResolvedValue([{ projectId: RESTRICTED }]);
    getAuthContext.mockResolvedValue(ctx());
    const ids = await listedIds(await GET(listReq(), { params }));
    expect(ids).toEqual(expect.arrayContaining([OPEN, RESTRICTED]));
  });

  it("shows it to the org OWNER (break-glass)", async () => {
    getAuthContext.mockResolvedValue(ctx({ orgRole: OrgRole.OWNER }));
    const ids = await listedIds(await GET(listReq(), { params }));
    expect(ids).toContain(RESTRICTED);
  });

  it("shows it to an org ADMIN (org-wide administration)", async () => {
    getAuthContext.mockResolvedValue(ctx({ orgRole: OrgRole.ADMIN }));
    const ids = await listedIds(await GET(listReq(), { params }));
    expect(ids).toContain(RESTRICTED);
  });

  it("HIDES it from a plain member carrying a delegated PROJECT_MANAGE grant", async () => {
    // Reported from the running app: a "Project Manager" work role hands
    // PROJECT_MANAGE to an ordinary member so they can run their own project.
    // Treating that as org-wide reach listed every restricted project in the org.
    getAuthContext.mockResolvedValue(
      ctx({
        orgRole: OrgRole.MEMBER,
        permissions: Permission.PROJECT_READ | Permission.PROJECT_MANAGE,
      }),
    );
    const ids = await listedIds(await GET(listReq(), { params }));
    expect(ids).not.toContain(RESTRICTED);
    expect(ids).toContain(OPEN);
  });

  it("leaves an org with nothing restricted completely unchanged", async () => {
    // The no-opt-in case is every existing org; it must not lose a project or
    // pay for a membership lookup.
    prisma.project.findMany.mockResolvedValue([
      { id: OPEN, orgId: ORG_ID, teamScopedAccess: false, name: "Open", key: "OPN", _count: {} },
    ]);
    getAuthContext.mockResolvedValue(ctx());
    const ids = await listedIds(await GET(listReq(), { params }));
    expect(ids).toEqual([OPEN]);
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });
});

describe("GET projects — a project-scoped API key cannot enumerate the others", () => {
  /**
   * The ceiling has to bind the LIST, not only each project's contents.
   *
   * Measured against production on 2026-09-15 with a real key scoped to one
   * project: every other project's work-items correctly returned 403, and this
   * endpoint still returned all six by name, key and counts. Refusing the
   * contents while publishing the inventory gives away exactly what the scope
   * exists to withhold — a token limited to one repository should not be able
   * to read the names of the others.
   *
   * `getVisibleProjectIds` is the FOURTH function needing this ceiling ahead of
   * its role short-circuit, after `getReadableProjectIds`, `isProjectVisible`
   * (its sibling in the same file) and `evaluateAccess`. The shape recurs
   * because every visibility helper has an owner break-glass, and a ceiling
   * placed after one binds everyone except the people most likely to mint a key.
   */
  it("lists only the project in its ceiling, even for an OWNER's key", async () => {
    getAuthContext.mockResolvedValue(
      ctx({ orgRole: OrgRole.OWNER, projectScope: [OPEN] }),
    );
    const res = await GET(listReq(), { params });
    expect(await listedIds(res)).toEqual([OPEN]);
  });

  it("hides even an unrestricted project that is outside the ceiling", async () => {
    // OPEN is teamScopedAccess:false, so nothing but the ceiling excludes it —
    // this is the case the `restricted.length === 0` shortcut would have let
    // straight through.
    getAuthContext.mockResolvedValue(
      ctx({ orgRole: OrgRole.OWNER, projectScope: [RESTRICTED] }),
    );
    expect(await listedIds(await GET(listReq(), { params }))).toEqual([RESTRICTED]);
  });

  it("lists nothing when the ceiling names no project in this org", async () => {
    getAuthContext.mockResolvedValue(
      ctx({ orgRole: OrgRole.OWNER, projectScope: ["99999999-9999-4999-8999-999999999999"] }),
    );
    expect(await listedIds(await GET(listReq(), { params }))).toEqual([]);
  });

  it("an UNSCOPED owner still sees both — the negative control", async () => {
    // Without this, a helper that returned nothing at all would satisfy every
    // assertion above while breaking the list for every ordinary caller.
    getAuthContext.mockResolvedValue(ctx({ orgRole: OrgRole.OWNER }));
    expect((await listedIds(await GET(listReq(), { params }))).sort())
      .toEqual([OPEN, RESTRICTED].sort());
  });
});
