// @vitest-environment node
//
// RBAC + GUARDRAILS for the PLATFORM-OWNER tenant-class flip route. Proves:
//   - a NON-internal-admin (incl. a tenant-admin) gets 403 — a tenant-admin can NEVER flip;
//   - a platform-owner flip to GOV applies the gov guardrails in the SAME transaction +
//     audits tenant_class.changed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getCurrentUser, isInternalAdmin, prisma, logAudit, applyGovGuardrails } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isInternalAdmin: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
  applyGovGuardrails: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser }));
vi.mock("@/lib/internal/access", () => ({ isInternalAdmin }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/runtime-config/guardrails", () => ({ applyGovGuardrails }));

import { PATCH } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const params = Promise.resolve({ orgId: ORG_ID });

function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/internal/orgs/${ORG_ID}/tenant-class`, {
    method: "PATCH", body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, tenantClass: "COMMERCIAL" });
  // Run the txn callback against a tx whose surface mirrors the real client.
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ organization: { update: vi.fn().mockResolvedValue({}) } }),
  );
});

describe("PATCH tenant-class — platform-owner RBAC", () => {
  it("403 when the caller is NOT signed in", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("403 for a tenant-admin (signed in but NOT an internal admin) — cannot flip tenantClass", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", email: "admin@tenant.com" });
    isInternalAdmin.mockReturnValue(false);
    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH tenant-class — platform-owner flip applies guardrails", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "owner-1", email: "owner@platform.com" });
    isInternalAdmin.mockReturnValue(true);
  });

  it("flip to GOV ⇒ applyGovGuardrails called in the txn + tenant_class.changed audited", async () => {
    const res = await PATCH(patch({ tenantClass: "GOV" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(applyGovGuardrails).toHaveBeenCalledWith(ORG_ID, expect.anything());
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tenant_class.changed",
        metadata: expect.objectContaining({ from: "COMMERCIAL", to: "GOV", guardrailsApplied: "true" }),
      }),
    );
  });

  it("flip to COMMERCIAL ⇒ NO guardrails applied (class change only)", async () => {
    prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, tenantClass: "GOV" });
    const res = await PATCH(patch({ tenantClass: "COMMERCIAL" }), { params });
    expect(res.status).toBe(200);
    expect(applyGovGuardrails).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ to: "COMMERCIAL", guardrailsApplied: "false" }) }),
    );
  });

  it("400 on an invalid tenantClass value", async () => {
    const res = await PATCH(patch({ tenantClass: "SECRET" }), { params });
    expect(res.status).toBe(400);
  });
});
