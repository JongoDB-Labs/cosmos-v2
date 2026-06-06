// @vitest-environment node
//
// Finance expense PUT — proves the FAIL-FAST pre-gate ordering. The route runs
// `requirePermission(ctx, FINANCE_MANAGE)` BEFORE loading the expense record, so
// a non-FINANCE_MANAGE member gets a uniform 403 and the money record is never
// even read (no 404-vs-403 existence oracle). The key assertion is therefore on
// CALL ORDERING: prisma.expense.findFirst must NOT have been called on the 403
// path. See the harness doc in the work-items route.test.ts for the pattern.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    expense: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXPENSE_ID = "55555555-5555-5555-5555-555555555555";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

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

function putRequest(body: Record<string, unknown> = { amount: 42 }): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/finance/expenses/e", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID, expenseId: EXPENSE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // A DRAFT expense so the edit-lock branch doesn't short-circuit the success path.
  prisma.expense.findFirst.mockResolvedValue({
    id: EXPENSE_ID,
    orgId: ORG_ID,
    status: "DRAFT",
    amount: 10,
    category: "travel",
    createdById: ACTOR_ID,
  });
  prisma.expense.update.mockResolvedValue({ id: EXPENSE_ID, amount: 42 });
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /finance/expenses/[expenseId] — FINANCE_MANAGE fail-fast pre-gate", () => {
  it("ctx LACKING FINANCE_MANAGE → 403 BEFORE the record load (findFirst NOT called)", async () => {
    // Has FINANCE_READ (can view) but not FINANCE_MANAGE (can't edit).
    getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_READ")));

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    // The whole point of the pre-gate: we reject before touching the money record,
    // so there's no 404-vs-403 oracle that leaks whether the expense exists.
    expect(prisma.expense.findFirst).not.toHaveBeenCalled();
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it("ctx WITH FINANCE_MANAGE → proceeds (loads record, updates, 200)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_READ", "FINANCE_MANAGE")));

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.expense.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.expense.update).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "expense.updated", entityId: EXPENSE_ID }),
    );
  });

  it("FINANCE_MANAGE but the record doesn't exist → 404 (record load DID run)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("FINANCE_READ", "FINANCE_MANAGE")));
    prisma.expense.findFirst.mockResolvedValue(null);

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(404);
    expect(prisma.expense.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });
});
