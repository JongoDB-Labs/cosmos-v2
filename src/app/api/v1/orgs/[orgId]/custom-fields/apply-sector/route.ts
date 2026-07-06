import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { seedSectorFields } from "@/lib/custom-fields/seed-sector-fields";
import { SECTOR_FIELD_SECTORS } from "@/lib/custom-fields/sector-field-templates";

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({
  sector: z.string().refine((s) => SECTOR_FIELD_SECTORS.includes(s), {
    message: "Unknown sector",
  }),
});

/**
 * Apply a sector's curated field set to the org (FR 454637a9) — the retrofit
 * path for existing projects (new template projects seed automatically).
 * Idempotent: keys that already exist are skipped, never overwritten.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CUSTOM_FIELD_MANAGE);

    const { sector } = bodySchema.parse(await request.json());
    const result = await seedSectorFields(orgId, sector);

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "custom_field.sector_applied",
      entity: "custom_field",
      metadata: {
        sector,
        created: String(result.created),
        skipped: String(result.skipped.length),
      } as Record<string, string>,
    }).catch(() => {});

    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
