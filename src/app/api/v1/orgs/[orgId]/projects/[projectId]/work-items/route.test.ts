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

const { avatarSrcs } = vi.hoisted(() => ({
  avatarSrcs: vi.fn<(orgId: string, users: Iterable<unknown>) => Promise<Map<string, string>>>(
    async () => new Map(),
  ),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/users/avatar-srcs.server", () => ({ avatarSrcs }));

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

describe("GET project work-items — assignee avatars", () => {
  const MAPPED = "55555555-5555-5555-5555-555555555555";
  const UNMAPPED = "66666666-6666-6666-6666-666666666666";
  const PNG = `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`;
  const SVG = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
  const URL_FOR_MAPPED = `/api/v1/orgs/${ORG_ID}/users/${MAPPED}/avatar?v=abcdef012345`;

  const row = (id: string, assignees: { id: string; avatarUrl: string | null }[]) => ({
    id, orgId: ORG_ID, projectId: PROJECT_ID, title: "t", description: "", columnKey: "todo",
    assigneeId: assignees[0]?.id ?? null, priority: "MEDIUM", parentId: null, ticketNumber: 1,
    storyPoints: null, sortOrder: 0, dueDate: null, startDate: null, actualStart: null,
    completedAt: null, columnEnteredAt: null, workCategory: "BUSINESS", archivedAt: null,
    cancelReason: null, cancelNote: null, mergedIntoId: null, tags: [], highlight: null,
    customFields: {}, createdById: ACTOR_ID, createdAt: new Date(0), updatedAt: new Date(0),
    workItemTypeId: ORG_MEMBER_ID, intervalId: null, teamId: null, externalSource: null,
    externalId: null, externalKey: null, sourceStatus: null, resolution: null,
    closeEvidenceNote: null, originalEstimate: null, remainingEstimate: null, timeSpent: null,
    sourceRecord: null, parent: null, children: [],
    workItemType: { id: ORG_MEMBER_ID, key: "software.task", name: "Task", icon: null, color: null },
    assignees: assignees.map((a) => ({ userId: a.id, user: { id: a.id, displayName: "U", avatarUrl: a.avatarUrl } })),
  });

  it("sends the mapped avatar URL, not the stored image, and leaves unmapped users as they are", async () => {
    getAuthContext.mockResolvedValue(ctx([]));
    prisma.workItem.findMany.mockResolvedValue([
      row("77777777-7777-7777-7777-777777777771", [{ id: MAPPED, avatarUrl: PNG }, { id: UNMAPPED, avatarUrl: SVG }]),
      row("77777777-7777-7777-7777-777777777772", [{ id: MAPPED, avatarUrl: PNG }]),
    ]);
    avatarSrcs.mockResolvedValue(new Map([[MAPPED, URL_FOR_MAPPED]]));

    const res = await GET(getRequest(), { params });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain(PNG);

    const body = JSON.parse(text);
    const rows = (body.data ?? body) as Array<{ assignees: Array<{ user: { id: string; avatarUrl: string | null } }> }>;
    const users = rows.flatMap((r) => r.assignees.map((a) => a.user));
    expect(users.filter((u) => u.id === MAPPED).map((u) => u.avatarUrl)).toEqual([URL_FOR_MAPPED, URL_FOR_MAPPED]);
    expect(users.find((u) => u.id === UNMAPPED)?.avatarUrl).toBe(SVG);

    // One call for the whole list, scoped to this org, not one per row.
    expect(avatarSrcs).toHaveBeenCalledTimes(1);
    expect(avatarSrcs.mock.calls[0][0]).toBe(ORG_ID);
  });
});
