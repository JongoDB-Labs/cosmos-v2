// @vitest-environment node
//
// ASYMMETRIC, COMPLIANCE-PRESERVING tenant-facing tenant-class route. Proves:
//   - an org OWNER may TIGHTEN (COMMERCIAL → GOV) — persists + applies gov guardrails in the
//     SAME txn + audits tenant_class.changed (by: tenant_owner);
//   - an org OWNER attempting to LOOSEN (GOV → COMMERCIAL) gets 403 pointing at a platform
//     admin — the AC-3 separation-of-duties control stays intact (loosening is platform-only);
//   - a NON-owner (even an ADMIN holding ORG_MANAGE_SETTINGS) gets 403 — OWNER-only gate;
//   - an invalid tenantClass is a 400.
//
// Mocks ONLY the I/O boundaries (session, db, audit, guardrails); the authz primitives
// (requirePermission/hasPermission) and the protectiveness ordering run FOR REAL against a
// crafted AuthContext — mirrors src/app/api/v1/orgs/[orgId]/members/[memberId]/route.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit, applyGovGuardrails } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
  applyGovGuardrails: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/runtime-config/guardrails", () => ({ applyGovGuardrails }));

import { PATCH } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const params = Promise.resolve({ orgId: ORG_ID });

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

/** ORG_MANAGE_SETTINGS is the base permission the route requires; OWNER and ADMIN both hold
 *  it, so the tests exercise the OWNER-role gate BEYOND it (an ADMIN must still be refused). */
function manageSettings(): bigint {
  return bits("ORG_READ", "ORG_MANAGE_SETTINGS");
}

function ctxWith(opts: { permissions?: bigint; orgRole: OrgRole }): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole,
    permissions: opts.permissions ?? manageSettings(),
    basePermissions: opts.permissions ?? manageSettings(),
    abacRules: [],
  };
}

function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/tenant-class`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** The org row the route reads (id/slug for auth, tenantClass = the CURRENT class). */
function mockOrg(tenantClass: "GOV" | "COMMERCIAL") {
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", tenantClass });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Run the txn callback against a tx whose surface mirrors the real client.
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ organization: { update: vi.fn().mockResolvedValue({}) } }),
  );
});

describe("PATCH /orgs/[orgId]/tenant-class — OWNER may TIGHTEN", () => {
  beforeEach(() => getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.OWNER })));

  it("COMMERCIAL → GOV persists, applies gov guardrails in the txn, audits by tenant_owner", async () => {
    mockOrg("COMMERCIAL");
    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: ORG_ID, tenantClass: "GOV" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(applyGovGuardrails).toHaveBeenCalledWith(ORG_ID, expect.anything());
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant_class.changed",
        userId: ACTOR_ID,
        metadata: expect.objectContaining({
          from: "COMMERCIAL",
          to: "GOV",
          guardrailsApplied: "true",
          by: "tenant_owner",
          direction: "tighten",
        }),
      }),
    );
  });

  it("no-op (COMMERCIAL → COMMERCIAL, equal protection) is allowed and applies NO guardrails", async () => {
    mockOrg("COMMERCIAL");
    const res = await PATCH(patch({ tenantClass: "COMMERCIAL" }), { params });

    expect(res.status).toBe(200);
    expect(applyGovGuardrails).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ to: "COMMERCIAL", guardrailsApplied: "false" }),
      }),
    );
  });
});

describe("PATCH /orgs/[orgId]/tenant-class — LOOSENING stays platform-owner-only", () => {
  it("OWNER attempting GOV → COMMERCIAL is refused 403 and pointed at a platform admin", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.OWNER }));
    mockOrg("GOV");

    const res = await PATCH(patch({ tenantClass: "COMMERCIAL" }), { params });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/platform admin/i);
    // The CUI boundary is untouched: no write, no guardrail call, no audit.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(applyGovGuardrails).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH /orgs/[orgId]/tenant-class — RBAC + validation", () => {
  it("403 for a non-owner ADMIN that DOES hold ORG_MANAGE_SETTINGS — OWNER-only gate", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.ADMIN }));
    mockOrg("COMMERCIAL");

    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("403 for a MEMBER lacking ORG_MANAGE_SETTINGS entirely", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ orgRole: OrgRole.MEMBER, permissions: bits("ORG_READ") }),
    );
    mockOrg("COMMERCIAL");

    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("401 when there is no auth context", async () => {
    getAuthContext.mockResolvedValue(null);
    mockOrg("COMMERCIAL");

    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });

    expect(res.status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("404 when the org does not exist", async () => {
    prisma.organization.findUnique.mockResolvedValue(null);

    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });

    expect(res.status).toBe(404);
  });

  it("400 on an invalid tenantClass value (OWNER)", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ orgRole: OrgRole.OWNER }));
    mockOrg("COMMERCIAL");

    const res = await PATCH(patch({ tenantClass: "SECRET" }), { params });

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
