// @vitest-environment node
//
// The concrete bug: a VOIDED entry could be submitted, and from there approved,
// and from there counted toward a CLIN's consumed funded value in
// lib/pm/burn.ts. Voiding is how a mistaken entry is withdrawn, so submitting
// one silently UNDOES the withdrawal and bills the hours anyway.
//
// The entry keeps `status: DRAFT` when voided — only `voidedAt` is set — so a
// lookup by (id, orgId) alone finds it and the DRAFT check waves it through.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    timeEntry: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const ENTRY_ID = "77777777-7777-7777-7777-777777777777";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}
const params = Promise.resolve({ orgId: ORG_ID, entryId: ENTRY_ID });
const req = () =>
  new NextRequest(
    `http://localhost/api/v1/orgs/o/time-entries/${ENTRY_ID}/submit`,
    { method: "POST" },
  );

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("TIME_UPDATE", "TIME_READ")));
  prisma.timeEntry.update.mockResolvedValue({ id: ENTRY_ID, status: "SUBMITTED" });
});

describe("POST /time-entries/[entryId]/submit — voided entries stay withdrawn", () => {
  /** Honours the where-clause, so the assertion measures the FILTER, not the
   *  mock. A fixed null would pass with or without the fix. */
  function entryIs(row: Record<string, unknown>) {
    prisma.timeEntry.findFirst.mockImplementation(
      ({ where }: { where: { voidedAt?: null } }) =>
        Promise.resolve(
          where.voidedAt === null && row.voidedAt != null ? null : row,
        ),
    );
  }

  it("a voided DRAFT entry cannot be submitted", async () => {
    entryIs({
      id: ENTRY_ID,
      userId: ACTOR_ID,
      status: "DRAFT",
      voidedAt: new Date("2026-07-31"),
    });

    const res = await POST(req(), { params });

    expect(res.status).toBe(404);
    // The decisive assertion: it must never reach the write that would put a
    // withdrawn entry back into the approval pipeline.
    expect(prisma.timeEntry.update).not.toHaveBeenCalled();
  });

  it("a live DRAFT entry still submits normally", async () => {
    // Guards against fixing the leak by breaking the feature.
    entryIs({ id: ENTRY_ID, userId: ACTOR_ID, status: "DRAFT", voidedAt: null });

    const res = await POST(req(), { params });

    expect(res.status).toBe(200);
    expect(prisma.timeEntry.update).toHaveBeenCalled();
  });
});
