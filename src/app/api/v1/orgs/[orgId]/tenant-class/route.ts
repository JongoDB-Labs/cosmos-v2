import { NextRequest } from "next/server";
import { z } from "zod";
import { TenantClass } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { applyGovGuardrails } from "@/lib/runtime-config/guardrails";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { isAtLeastAsProtective } from "@/lib/org/tenant-class";

// TENANT-FACING, TIGHTEN-ONLY tenant-class control. This ADDS a self-service path ALONGSIDE
// the platform-owner route at /api/internal/orgs/[orgId]/tenant-class — it does NOT replace it,
// and it deliberately PRESERVES the AC-3 separation-of-duties control (compliance/ssp/SSP.md).
//
// The asymmetry is the whole point:
//   - An org OWNER may TIGHTEN their own org to an EQUAL-or-MORE-protective class
//     (e.g. COMMERCIAL → GOV). Tightening only ever INCREASES the CUI-blind masking, so it can
//     never leak CUI to the model — it is always safe for a tenant to do to themselves.
//   - LOOSENING (moving to a LESS-protective class, e.g. GOV → COMMERCIAL) REMOVES masking and
//     stays PLATFORM-OWNER-ONLY (the internal route). A tenant OWNER attempting it gets a 403
//     directing them to a platform admin — a gov tenant must not disable its own CUI protection.
//
// On a tighten TO gov we apply the gov guardrails in the SAME transaction as the class change,
// exactly like the internal route, so the org is never momentarily gov-with-breadth.

const patchSchema = z.object({
  tenantClass: z.nativeEnum(TenantClass),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true, tenantClass: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // OWNER-only. ORG_MANAGE_SETTINGS is the base permission bar; the explicit OWNER-role
    // check is the real gate — an ADMIN holds ORG_MANAGE_SETTINGS but must NOT be able to move
    // the CUI boundary. Mirrors the OWNER-escalation guard in members/[memberId]/route.ts.
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
    if (ctx.orgRole !== "OWNER") {
      throw new ForbiddenError("Only the organization owner can change the tenant class.");
    }

    const { tenantClass } = patchSchema.parse(await request.json());
    const prior = org.tenantClass;

    // ASYMMETRIC GUARD — the compliance-preserving heart of this route. A tenant OWNER may only
    // TIGHTEN (target at least as protective as current). LOOSENING removes CUI masking and is
    // reserved for a platform owner via the internal route — refuse it here and point the owner
    // at a platform admin, so the SSP's "a tenant-admin can NEVER flip it [looser]" stays true.
    if (!isAtLeastAsProtective(tenantClass, prior)) {
      throw new ForbiddenError(
        "Reducing this organization's tenant class removes CUI masking and is not self-service. " +
          "Contact your platform administrator to request this change.",
      );
    }

    // Persist the tighten. On a move TO gov, apply the gov guardrails in the SAME txn so the org
    // is never momentarily gov-with-breadth — identical posture to the platform-owner route.
    await prisma.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: orgId }, data: { tenantClass } });
      if (tenantClass === "GOV") {
        await applyGovGuardrails(orgId, tx);
      }
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "tenant_class.changed",
      entity: "organization",
      entityId: orgId,
      metadata: {
        from: prior,
        to: tenantClass,
        guardrailsApplied: tenantClass === "GOV" ? "true" : "false",
        by: "tenant_owner",
        direction: "tighten",
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ orgId, tenantClass });
  } catch (error) {
    return handleApiError(error);
  }
}
