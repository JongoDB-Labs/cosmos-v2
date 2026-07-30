// @vitest-environment node
//
// Regression: an ABAC ITEM_READ deny must be honoured by the PROJECT board's
// own work-items GET, not just by the org-wide Issues surfaces.
//
// The access-control audit (docs/design/access-control-audit.md, finding 5)
// found this GET gating on `requirePermission(ITEM_READ)` — a pure bitmask test
// that never consults `ctx.abacRules` — while the cross-project surfaces
// (search / facets / activity / row) narrow through `getReadableProjectIds`,
// which folds the same deny in. The POST in this very file already went through
// `requireAccess`. So a policy that hid a project from an actor's Issues list
// left its board readable by requesting the project's URL directly.
//
// The authz decision runs FOR REAL here (requireAccess + evaluateAccess against
// a crafted AuthContext and mocked prisma) — that decision is the whole point.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
    workItem: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";
const ORG_MEMBER_ID = "44444444-4444-4444-4444-444444444444";

/** Deny ITEM_READ to actors who are members of the project in question. */
const DENY_ITEM_READ_IN_PROJECT: AbacRule = {
  effect: "deny",
  actions: ["ITEM_READ"],
  conditions: [{ rel: "in_project" }],
};

function ctx(abacRules: AbacRule[]): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    // MEMBER, not OWNER: OWNER is break-glass and bypasses policy by design.
    orgRole: OrgRole.MEMBER,
    permissions: Permission.ITEM_READ,
    basePermissions: Permission.ITEM_READ,
    abacRules,
  };
}

function getRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/work-items`,
  );
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findFirst.mockResolvedValue({ id: PROJECT_ID, orgId: ORG_ID });
  prisma.workItem.findMany.mockResolvedValue([]);
  // The actor IS a member of this project, so `in_project` resolves TRUE and
  // the deny rule fires. Resolved through OrgMember.id, never User.id.
  prisma.orgMember.findUnique.mockResolvedValue({ id: ORG_MEMBER_ID });
  prisma.projectMember.findFirst.mockResolvedValue({ orgMemberId: ORG_MEMBER_ID });
});

describe("GET project work-items — ABAC enforcement", () => {
  it("403s when a policy denies ITEM_READ for this project", async () => {
    getAuthContext.mockResolvedValue(ctx([DENY_ITEM_READ_IN_PROJECT]));

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(403);
    // The denial must happen BEFORE any items are read, not by filtering after.
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("still serves the board when no policy denies it", async () => {
    // Guards against 'fix' by blanket-denying: with no rules, the same actor and
    // the same ITEM_READ bit must still get their items.
    getAuthContext.mockResolvedValue(ctx([]));

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.workItem.findMany).toHaveBeenCalled();
  });

  it("403s when the actor lacks the ITEM_READ bit entirely", async () => {
    // The pre-existing bitmask gate must survive the change to requireAccess.
    getAuthContext.mockResolvedValue({ ...ctx([]), permissions: 0n, basePermissions: 0n });

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });
});
