import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { isInternalAdmin } from "@/lib/internal/access";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

// The billing PLAN is a PLATFORM-OWNER decision: only an internal admin
// (isInternalAdmin against INTERNAL_ADMINS) may change an org's plan. An org
// owner/admin can NEVER reach this route — it lives under /api/internal, gated
// below — so plan is never org-owner self-service. This mirrors the internal
// tenant-class route. Plan drives FEATURES; the separate tenantClass drives
// data-classification and is changed by its own control.

const patchSchema = z.object({
  plan: z.enum(["BASIC", "TEAM", "ENTERPRISE"]),
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
      select: { id: true, slug: true, name: true, plan: true },
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
      select: { id: true, plan: true },
    });
    if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { plan } = patchSchema.parse(await request.json());
    const prior = org.plan;

    await prisma.organization.update({ where: { id: orgId }, data: { plan } });

    await logAudit({
      orgId,
      userId: user.id,
      action: "plan.changed",
      entity: "organization",
      entityId: orgId,
      metadata: {
        from: prior,
        to: plan,
        by: "platform_owner",
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ orgId, plan });
  } catch (error) {
    return handleApiError(error);
  }
}
