// @vitest-environment node
//
// GET /saved-views: a view shared org-wide by a member of a team-scoped
// project must not be listed to a member who cannot read that project. Mocks
// only the I/O boundaries (auth, prisma); getReadableProjectIds and
// visibleSavedViews run for real.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn() },
    savedView: { findMany: vi.fn() },
    interval: { findMany: vi.fn() },
    workItem: { findMany: vi.fn() },
    customField: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "44444444-4444-4444-8444-444444444444";
const OWNER_OF_VIEW = "77777777-7777-4777-8777-777777777777";
const P_OPEN = "22222222-2222-4222-8222-222222222222";
const P_TEAM = "33333333-3333-4333-8333-333333333333"; // teamScopedAccess, I'm not on it

function ctx(orgRole: OrgRole): AuthContext {
  return {
    userId: ME,
    orgId: ORG,
    orgRole,
    permissions: Permission.ITEM_READ,
    basePermissions: Permission.ITEM_READ,
    abacRules: [],
  };
}

function row(id: string, ownerId: string, filter: unknown, shared = true) {
  return { id, name: id, filter, shared, ownerId, owner: { displayName: "X" }, updatedAt: new Date(0) };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme" });
  prisma.project.findMany.mockResolvedValue([
    { id: P_OPEN, teamScopedAccess: false },
    { id: P_TEAM, teamScopedAccess: true },
  ]);
  prisma.orgMember.findUnique.mockResolvedValue({ id: "m1" });
  prisma.projectMember.findMany.mockResolvedValue([]);
  prisma.interval.findMany.mockResolvedValue([]);
  prisma.workItem.findMany.mockResolvedValue([]);
  prisma.customField.findMany.mockResolvedValue([]);
  prisma.savedView.findMany.mockResolvedValue([
    row("team-only", OWNER_OF_VIEW, { projectIds: [P_TEAM] }),
    row("open", OWNER_OF_VIEW, { projectIds: [P_OPEN] }),
    row("mine-team", ME, { projectIds: [P_TEAM] }, false),
  ]);
});

const req = () => new NextRequest(`http://localhost/api/v1/orgs/${ORG}/saved-views`);
const params = Promise.resolve({ orgId: ORG });

describe("GET /saved-views — shared views are scoped to what the viewer can read", () => {
  it("a member not on the team-scoped project does not see a view naming it", async () => {
    getAuthContext.mockResolvedValue(ctx(OrgRole.MEMBER));
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((v) => v.id)).toEqual(["open", "mine-team"]);
  });

  it("an org admin reads every project, so sees every shared view", async () => {
    getAuthContext.mockResolvedValue(ctx(OrgRole.ADMIN));
    const res = await GET(req(), { params });
    const body = (await res.json()) as { id: string }[];
    expect(body.map((v) => v.id)).toEqual(["team-only", "open", "mine-team"]);
  });
});
