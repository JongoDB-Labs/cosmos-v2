import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { updateTimeOffAllowance } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Set a time-off allowance: one person's for one year, or the org default.
 *
 * Only the allowance is ever written. Used, approved and remaining are derived
 * from the requests on every read, so changing an allowance can never leave a
 * stale balance behind it.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx, org } = await orgContext((await params).orgId, updateTimeOffAllowance);
    const { body } = await parseRequest(updateTimeOffAllowance, request, params);
    // Both bits, checked visibly here rather than through a helper, so the
    // scope tests can read what this write requires. Same rule as
    // canManageAllowances, which tells the UI whether to offer editing.
    requirePermission(ctx, Permission.TIME_READ_ALL);
    requirePermission(ctx, Permission.TIME_APPROVE);

    const audit = (metadata: Record<string, string>) =>
      logAudit({
        orgId: org.id,
        userId: ctx.userId,
        action: "time_off.allowance_updated",
        entity: "organization",
        entityId: org.id,
        metadata,
        ipAddress: getIpAddress(request),
      });

    if (body.userId) {
      if (body.year === undefined || body.hours === undefined) {
        return problem(400, "invalid_request", "A person's allowance needs a year and hours (null to use the default).", { request });
      }
      const member = await prisma.orgMember.findUnique({
        where: { orgId_userId: { orgId: org.id, userId: body.userId } },
        select: { id: true },
      });
      if (!member) return problem(404, "not_found", "That person isn't in this organization.", { request });

      const where = { orgId_userId_year: { orgId: org.id, userId: body.userId, year: body.year } };
      if (body.hours === null) {
        await prisma.timeOffAllowance.deleteMany({ where: { orgId: org.id, userId: body.userId, year: body.year } });
      } else {
        await prisma.timeOffAllowance.upsert({
          where,
          create: { orgId: org.id, userId: body.userId, year: body.year, hours: body.hours, updatedById: ctx.userId },
          update: { hours: body.hours, updatedById: ctx.userId },
        });
      }
      await audit({ subjectUserId: body.userId, year: String(body.year), hours: body.hours === null ? "default" : String(body.hours) });
      return respond(updateTimeOffAllowance, 200, { ok: true as const });
    }

    // The org default. Merged in one statement, so a concurrent change to any
    // other org setting is not overwritten by a stale read.
    const patch: Record<string, unknown> = {};
    if (body.hours !== undefined) patch.annualAllowanceHours = body.hours;
    if (body.countedKinds !== undefined) patch.countedKinds = body.countedKinds;
    if (Object.keys(patch).length === 0) {
      return problem(400, "invalid_request", "Send hours or countedKinds.", { request });
    }
    await prisma.$executeRaw`
      UPDATE organizations
      SET settings = jsonb_set(
        jsonb_set(COALESCE(settings, '{}'::jsonb), '{time}', COALESCE(settings->'time', '{}'::jsonb)),
        '{time,timeOff}',
        COALESCE(settings->'time'->'timeOff', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      )
      WHERE id = ${org.id}::uuid
    `;
    await audit({ default: JSON.stringify(patch) });
    return respond(updateTimeOffAllowance, 200, { ok: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}
