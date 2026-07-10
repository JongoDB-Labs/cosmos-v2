// @vitest-environment node
//
// Regression lock for COSMOS-2 ("Failed to create work role" → 500). Runs
// against the REAL e2e DB (seeded `test-org` / `alice@test.local`) so the actual
// `prisma.workRole.create` write executes. Only `getAuthContext` is mocked
// (session cookies aren't available in a route-handler test).
//
// The permission space spans bits 0..116 (src/lib/rbac/permissions.ts). When
// `work_roles.grants` was a 64-bit int8 column, granting ANY permission at bit
// >= 63 (CRM, NOTE, TIME, THEME, COMPLIANCE, CHAT, AGENT_POLICY_MANAGE, …)
// overflowed the column → Prisma P2020 → a 500. Storing the mask as a decimal
// text string fixes it. This test creates a role granting the HIGHEST bit and
// asserts a 201 with a correct round-trip.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { RolePermissions, Permission } from "@/lib/rbac/permissions";

const { getAuthContext, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
// The audit store is append-only (AU-9) — mock the write so this test leaves no
// undeletable rows in the shared e2e DB. The grant storage is what's under test.
vi.mock("@/lib/audit", () => ({ logAudit }));

import { prisma } from "@/lib/db/client";
import { POST } from "./route";

const KEY_PREFIX = "cosmos2_highbit_";

let orgId: string;
let userId: string;

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/work-roles`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function purge() {
  const roles = await prisma.workRole.findMany({
    where: { orgId, key: { startsWith: KEY_PREFIX } },
    select: { id: true },
  });
  for (const r of roles) {
    await prisma.workRole.delete({ where: { id: r.id } });
  }
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;
  const user = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  userId = user.id;

  // OWNER base holds every bit, so the authoring-ceiling guard passes for any grant.
  const ctx: AuthContext = {
    userId,
    orgId,
    orgRole: OrgRole.OWNER,
    permissions: RolePermissions.OWNER,
    basePermissions: RolePermissions.OWNER,
    abacRules: [],
  };
  getAuthContext.mockResolvedValue(ctx);

  await purge();
});

afterAll(async () => {
  await purge();
});

describe("POST /work-roles — high-bit permission grants (e2e)", () => {
  it("persists a role granting a bit >= 63 (was a 500 on the 64-bit column)", async () => {
    // AGENT_POLICY_MANAGE is bit 116 — far beyond int8's 64-bit ceiling.
    const grants = ["FINANCE_READ", "AUDIT_LOG_READ", "AGENT_POLICY_MANAGE"];
    const key = `${KEY_PREFIX}${Date.now()}`;

    const res = await POST(
      post({ key, name: "High-bit auditor", grants }),
      { params: Promise.resolve({ orgId }) },
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(new Set(json.grants)).toEqual(new Set(grants));

    // The stored value is the decimal bitmask (with bit 116 set), well past 2^63.
    const row = await prisma.workRole.findUniqueOrThrow({
      where: { id: json.id },
      select: { grants: true },
    });
    const expectedMask =
      Permission.FINANCE_READ |
      Permission.AUDIT_LOG_READ |
      Permission.AGENT_POLICY_MANAGE;
    expect(BigInt(row.grants)).toBe(expectedMask);
    expect(BigInt(row.grants) > (1n << 63n)).toBe(true);
  });
});
