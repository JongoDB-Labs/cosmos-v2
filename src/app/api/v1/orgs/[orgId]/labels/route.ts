import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { resolveLabels } from "@/lib/work-items/labels";
import { z } from "zod";

const createLabelSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(30).nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org's label catalogue, with how many work items carry each.
 *
 * `?projectId=` narrows the COUNT to that project rather than the list — the
 * management UI needs "what does this org have" and "how much is it used over
 * here" at once, and dropping unused labels from the list would hide exactly
 * the ones an admin wants to clean up.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const projectId = request.nextUrl.searchParams.get("projectId");

    const labels = await prisma.label.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
    });

    const counts = await prisma.workItemLabel.groupBy({
      by: ["labelId"],
      where: {
        orgId,
        ...(projectId ? { workItem: { projectId } } : {}),
      },
      _count: { _all: true },
    });
    const countById = new Map(counts.map((c) => [c.labelId, c._count._all]));

    return success(
      labels.map((l) => ({ ...l, itemCount: countById.get(l.id) ?? 0 })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Create a label.
 *
 * Gated on ITEM_UPDATE rather than an admin permission: naming a new label is
 * part of ordinary tagging, and requiring an admin would push people straight
 * back to typing free-text. Renaming and deleting are the org-wide operations,
 * and those are admin-gated on the [labelId] route.
 *
 * Returns the EXISTING row when the name already exists in any casing — the
 * point of the catalogue is that an org has one "Security", so asking for it
 * twice is a no-op, not a conflict the caller has to handle.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_UPDATE);

    const data = createLabelSchema.parse(await request.json());

    const [label] = await resolveLabels(prisma, orgId, [data.name]);
    if (!label) {
      return new Response(JSON.stringify({ error: "Label name is empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (data.color !== undefined && data.color !== null) {
      await prisma.label.update({
        where: { id: label.id },
        data: { color: data.color },
      });
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "label.create",
      entity: "label",
      entityId: label.id,
      metadata: { name: label.name },
      ipAddress: getIpAddress(request),
    });

    return created(await prisma.label.findUniqueOrThrow({ where: { id: label.id } }));
  } catch (error) {
    return handleApiError(error);
  }
}
