import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { isInternalAdmin } from "@/lib/internal/access";
import { applyGovGuardrails } from "@/lib/runtime-config/guardrails";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

// The GOV designation is a PLATFORM-OWNER decision (design §8): only an internal admin
// (isInternalAdmin against INTERNAL_ADMINS) may flip an org's tenantClass. A tenant-admin
// can NEVER reach this route (it lives under /api/internal, gated below). On a flip TO gov
// we ATOMICALLY apply the gov guardrails (breadth/mcp off + strip commercial-only providers)
// in the SAME transaction as the class change, so the org is never momentarily gov-with-breadth.

const patchSchema = z.object({
  tenantClass: z.enum(["GOV", "COMMERCIAL"]),
});

type RouteParams = { params: Promise<{ orgId: string }> };

/** Platform-owner gate: the caller must be an INTERNAL admin. Returns the user or null. */
async function requirePlatformOwner() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!isInternalAdmin(user.email, process.env.INTERNAL_ADMINS)) return null;
  return user;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const user = await requirePlatformOwner();
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true, name: true, tenantClass: true },
    });
    if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return success(org);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const user = await requirePlatformOwner();
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, tenantClass: true },
    });
    if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { tenantClass } = patchSchema.parse(await request.json());
    const prior = org.tenantClass;

    // Set the class AND (on a flip to GOV) apply the gov guardrails in ONE transaction so the
    // org is never observably gov-with-breadth. Flipping to COMMERCIAL only changes the class —
    // it does NOT auto-re-enable breadth (a tenant-admin opts in afterward, within bounds).
    await prisma.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: orgId }, data: { tenantClass } });
      if (tenantClass === "GOV") {
        await applyGovGuardrails(orgId, tx);
      }
    });

    await logAudit({
      orgId,
      userId: user.id,
      action: "tenant_class.changed",
      entity: "organization",
      entityId: orgId,
      metadata: {
        from: prior,
        to: tenantClass,
        guardrailsApplied: tenantClass === "GOV" ? "true" : "false",
        by: "platform_owner",
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ orgId, tenantClass });
  } catch (error) {
    return handleApiError(error);
  }
}
