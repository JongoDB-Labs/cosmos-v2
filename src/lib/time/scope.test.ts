// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: { employee: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { readableTimeUserIds, timeUserIdFilter } from "./scope";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = "44444444-4444-4444-4444-444444444444";
const REPORT_A = "55555555-5555-5555-5555-555555555555";
const REPORT_B = "66666666-6666-6666-6666-666666666666";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("readableTimeUserIds", () => {
  it("TIME_READ_ALL means no restriction, and asks the DB nothing", async () => {
    const result = await readableTimeUserIds(ctxWith(bits("TIME_READ", "TIME_READ_ALL")));

    expect(result).toBeNull();
    // The org-wide reader needs no org-chart lookup — a query here would be
    // pure waste on the hottest path.
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it("with no employee record at all, the actor still reads their own time", async () => {
    prisma.employee.findMany.mockResolvedValue([]);

    expect(await readableTimeUserIds(ctxWith(bits("TIME_READ")))).toEqual([ACTOR]);
  });

  it("a supervisor reads their own time plus their direct reports'", async () => {
    prisma.employee.findMany.mockResolvedValue([
      { userId: ACTOR },
      { userId: REPORT_A },
      { userId: REPORT_B },
    ]);

    const result = await readableTimeUserIds(ctxWith(bits("TIME_READ")));

    expect(result).toEqual([ACTOR, REPORT_A, REPORT_B]);
  });

  it("does not duplicate the actor when their own employee row comes back", async () => {
    // The query matches the actor's own row AND their reports, so the actor
    // appears twice unless deduped — a duplicate would inflate nothing
    // security-wise but makes the IN clause and any logging noisy.
    prisma.employee.findMany.mockResolvedValue([{ userId: ACTOR }, { userId: ACTOR }]);

    expect(await readableTimeUserIds(ctxWith(bits("TIME_READ")))).toEqual([ACTOR]);
  });

  it("scopes the org-chart lookup to the actor's own org", async () => {
    prisma.employee.findMany.mockResolvedValue([]);

    await readableTimeUserIds(ctxWith(bits("TIME_READ")));

    const where = prisma.employee.findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG_ID);
    // The supervisor side is scoped at BOTH hops — the join row and the
    // supervisor's own employee record. Neither FK keeps a row in the same
    // tenant by itself, so an unscoped join could pull a foreign org's reports.
    expect(where.OR).toContainEqual({
      supervisors: {
        some: {
          orgId: ORG_ID,
          supervisor: { orgId: ORG_ID, userId: ACTOR },
        },
      },
    });
  });

  it("fails NARROW when the lookup throws — never widens to the org", async () => {
    prisma.employee.findMany.mockRejectedValue(new Error("db down"));

    // The dangerous failure would be returning null (= no restriction).
    expect(await readableTimeUserIds(ctxWith(bits("TIME_READ")))).toEqual([ACTOR]);
  });
});

describe("timeUserIdFilter", () => {
  it("null becomes undefined — 'no filter' to Prisma", () => {
    expect(timeUserIdFilter(null)).toBeUndefined();
  });

  it("a set becomes an IN clause", () => {
    expect(timeUserIdFilter([ACTOR, REPORT_A])).toEqual({
      in: [ACTOR, REPORT_A],
    });
  });
});
