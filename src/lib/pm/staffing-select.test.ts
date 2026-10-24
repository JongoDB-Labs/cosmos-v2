// @vitest-environment node
//
// The staffing lens must not read the permission mask.
//
// AGENTS.md ("Server-side response patterns") and prisma/schema.prisma both say
// project members are loaded with an explicit `select` that EXCLUDES
// `OrgMember.permissions`. `loadStaffing` used `include: { orgMember: { … } }`,
// which pulls the whole OrgMember row — mask included — into memory for every
// staffed person on the project.
//
// Asserting the query shape rather than the returned rows is deliberate: an
// `include` and a `select` produce the same `StaffRow`s, so nothing about the
// output can tell the two apart. The defect lives in what was fetched.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    projectMember: { findMany: vi.fn() },
    employee: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { loadStaffing } from "./staffing";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.projectMember.findMany.mockResolvedValue([
    {
      id: "pm1",
      role: "MEMBER",
      allocationPercent: 50,
      onContract: true,
      cacStatus: "active",
      cacExpiry: null,
      trainingStatus: "complete",
      accessStatus: "granted",
      ndaStatus: "executed",
      complianceNotes: null,
      orgMember: { userId: USER_ID, user: { id: USER_ID, displayName: "Ada Lovelace" } },
    },
  ]);
  prisma.employee.findMany.mockResolvedValue([]);
});

describe("loadStaffing never fetches OrgMember.permissions", () => {
  it("selects only userId and the nested user from orgMember", async () => {
    await loadStaffing(ORG_ID, PROJECT_ID, { includeCost: false });

    expect(prisma.projectMember.findMany).toHaveBeenCalledTimes(1);
    const orgMemberClause = prisma.projectMember.findMany.mock.calls[0][0].include.orgMember;

    // An `include` here would hand back every OrgMember column, the mask among
    // them, no matter what the nested clause says.
    expect(orgMemberClause.include).toBeUndefined();
    expect(Object.keys(orgMemberClause.select).sort()).toEqual(["user", "userId"]);
    expect(orgMemberClause.select.permissions).toBeUndefined();
  });

  it("still resolves the staffed person's name through that select", async () => {
    // Guards the guard: a select narrowed past what the mapping reads would
    // satisfy the assertion above and break the screen.
    const rows = await loadStaffing(ORG_ID, PROJECT_ID, { includeCost: false });
    expect(rows.map((r) => [r.userId, r.name])).toEqual([[USER_ID, "Ada Lovelace"]]);
  });
});
