// @vitest-environment node
//
// `GET /meetings` must not list meetings on projects the caller cannot open.
//
// MEETING_READ is held by MEMBER and VIEWER, so it authorises reading SOME
// meetings and says nothing about WHICH. `SyncMeeting.projectId` is real, so an
// org-only filter listed every meeting in the organisation — records that carry
// notes and transcripts.
//
// The AGENT was fixed first (2.265.3), which left the UI looser than the
// assistant: a user could see a meeting on screen that Cosmo refused to discuss.
// This closes it from the other end, so both surfaces answer the same question.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    syncMeeting: { findMany: vi.fn() },
    // The real meeting-read rule (meeting-reader.ts) runs: the org's projects,
    // and the caller's project memberships for a team-scoped one.
    project: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const OPEN_PROJECT = "33333333-3333-4333-a333-333333333333";
const HIDDEN_PROJECT = "44444444-4444-4444-a444-444444444444";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
const ctx: AuthContext = {
  userId: ME,
  orgId: ORG_ID,
  orgRole: OrgRole.MEMBER,
  permissions: bits("MEETING_READ"),
  basePermissions: bits("MEETING_READ"),
  abacRules: [],
};
const params = Promise.resolve({ orgId: ORG_ID });
const req = (qs = "") =>
  new NextRequest(`http://localhost/api/v1/orgs/o/meetings${qs}`);

/** The org's projects, filtered by the `id: { in }` a single-project question asks with. */
function projectsInOrg(rows: { id: string; teamScopedAccess: boolean }[]) {
  prisma.project.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
    args?.where?.id?.in ? rows.filter((r) => args.where!.id!.in!.includes(r.id)) : rows,
  );
}

const lastWhere = () =>
  prisma.syncMeeting.findMany.mock.calls.at(-1)?.[0]?.where as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctx);
  // OPEN_PROJECT is anyone's; HIDDEN_PROJECT is team-scoped, and the caller isn't on its team.
  projectsInOrg([
    { id: OPEN_PROJECT, teamScopedAccess: false },
    { id: HIDDEN_PROJECT, teamScopedAccess: true },
  ]);
  prisma.orgMember.findUnique.mockResolvedValue({ id: "member-1" });
  prisma.projectMember.findMany.mockResolvedValue([]);
  prisma.syncMeeting.findMany.mockResolvedValue([]);
});

describe("GET /meetings — project scope", () => {
  it("lists only meetings on projects the caller can open, plus org-level ones", async () => {
    // Meetings with NO project are org-level and must stay visible — dropping
    // them would be a different bug, and a common one when adding an `in`
    // filter to a nullable column.
    await GET(req(), { params });

    expect(prisma.project.findMany).toHaveBeenCalled();
    expect(lastWhere().OR).toEqual([
      { projectId: null },
      { projectId: { in: [OPEN_PROJECT] } },
    ]);
  });

  it("DENIES a project the caller cannot open", async () => {
    const res = await GET(req(`?projectId=${HIDDEN_PROJECT}`), { params });

    expect(res.status).toBe(403);
    // Denied before the query, not filtered after it.
    expect(prisma.syncMeeting.findMany).not.toHaveBeenCalled();
  });

  it("allows a project the caller CAN open", async () => {
    await GET(req(`?projectId=${OPEN_PROJECT}`), { params });

    expect(lastWhere().projectId).toBe(OPEN_PROJECT);
  });

  it("returns only org-level meetings when no project is readable", async () => {
    // An empty readable set must mean "org-level only", never "no filter".
    projectsInOrg([{ id: HIDDEN_PROJECT, teamScopedAccess: true }]);

    await GET(req(), { params });

    expect(lastWhere().OR).toEqual([
      { projectId: null },
      { projectId: { in: [] } },
    ]);
  });

  it("still requires MEETING_READ", async () => {
    getAuthContext.mockResolvedValue({ ...ctx, permissions: 0n });

    expect((await GET(req(), { params })).status).toBe(403);
  });
});
