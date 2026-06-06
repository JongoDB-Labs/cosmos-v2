import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, revokeOrgSessions } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateSettingsSchema = z.object({
  mfaRequired: z.boolean().optional(),
  sessionTimeoutMins: z.number().int().min(5).max(43200).optional(),
  ipAllowlistEnabled: z.boolean().optional(),
  scimEnabled: z.boolean().optional(),
  ssoEnforced: z.boolean().optional(),
  ssoConnectionId: z.string().nullable().optional(),
  allowedDomains: z.array(z.string()).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
});

/**
 * AU-11 gov retention floor: GOV-class tenants must retain audit logs for at least
 * 3 years (1095 days). We coerce up rather than reject so the floor can't be lowered.
 * Commercial tenants keep the schema's 30–3650 range. Returns the (possibly clamped)
 * value; `undefined` in → `undefined` out (no change requested).
 */
export const GOV_AUDIT_RETENTION_FLOOR_DAYS = 1095;

export function clampGovRetentionDays(
  tenantClass: string,
  auditRetentionDays: number | undefined,
): number | undefined {
  if (auditRetentionDays === undefined) return undefined;
  if (tenantClass === "GOV" && auditRetentionDays < GOV_AUDIT_RETENTION_FLOOR_DAYS) {
    return GOV_AUDIT_RETENTION_FLOOR_DAYS;
  }
  return auditRetentionDays;
}

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const settings = await prisma.orgSecuritySettings.upsert({
      where: { orgId },
      create: { orgId },
      update: {},
    });

    return success(settings);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const body = await request.json();
    const data = updateSettingsSchema.parse(body);

    // AU-11: enforce the gov retention floor (>=3yr) for GOV-class tenants.
    data.auditRetentionDays = clampGovRetentionDays(org.tenantClass, data.auditRetentionDays);

    // Snapshot the prior posture so we can detect a *tightening* below (false→true).
    const prior = await prisma.orgSecuritySettings.findUnique({
      where: { orgId },
      select: { ssoEnforced: true, mfaRequired: true },
    });

    const settings = await prisma.orgSecuritySettings.upsert({
      where: { orgId },
      create: {
        orgId,
        ...data,
        ssoConnectionId: data.ssoConnectionId ?? null,
      },
      update: {
        ...(data.mfaRequired !== undefined && { mfaRequired: data.mfaRequired }),
        ...(data.sessionTimeoutMins !== undefined && { sessionTimeoutMins: data.sessionTimeoutMins }),
        ...(data.ipAllowlistEnabled !== undefined && { ipAllowlistEnabled: data.ipAllowlistEnabled }),
        ...(data.scimEnabled !== undefined && { scimEnabled: data.scimEnabled }),
        ...(data.ssoEnforced !== undefined && { ssoEnforced: data.ssoEnforced }),
        ...(data.ssoConnectionId !== undefined && { ssoConnectionId: data.ssoConnectionId }),
        ...(data.allowedDomains !== undefined && { allowedDomains: data.allowedDomains }),
        ...(data.auditRetentionDays !== undefined && { auditRetentionDays: data.auditRetentionDays }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "security_settings.updated",
      entity: "org_security_settings",
      entityId: settings.id,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // When a GOV org TIGHTENS its auth posture (SSO enforced or MFA required,
    // false→true), revoke all existing member sessions so weaker-assurance
    // sessions (Google / pre-enforcement) can't ride past the new floor. Only
    // on the rising edge — re-saving an already-strict policy is a no-op.
    const tightenedSso =
      data.ssoEnforced === true && prior?.ssoEnforced !== true;
    const tightenedMfa =
      data.mfaRequired === true && prior?.mfaRequired !== true;
    if (org.tenantClass === "GOV" && (tightenedSso || tightenedMfa)) {
      const revoked = await revokeOrgSessions(orgId);
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "security_settings.sessions_revoked",
        entity: "org_security_settings",
        entityId: settings.id,
        metadata: {
          reason: tightenedSso ? "sso_enforced" : "mfa_required",
          revokedCount: String(revoked),
        } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
    }

    return success(settings);
  } catch (error) {
    return handleApiError(error);
  }
}
