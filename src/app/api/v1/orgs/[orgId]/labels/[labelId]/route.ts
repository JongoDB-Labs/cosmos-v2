import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { recomputeTagMirror } from "@/lib/work-items/labels";
import { z } from "zod";

const updateLabelSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.string().max(30).nullish(),
});

type RouteParams = { params: Promise<{ orgId: string; labelId: string }> };

/**
 * Rename or recolour a label — and merge it when the new name is already taken.
 *
 * Renaming onto an existing name is the natural way an admin cleans up a
 * duplicate ("Sec" → "Security"), so it merges rather than erroring: the items
 * move onto the surviving label and the now-empty one is deleted. Rejecting it
 * would leave them with no way to do the one thing they came here for.
 *
 * Admin-gated because it rewrites every item carrying the label, across every
 * project in the org.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, labelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    const existing = await prisma.label.findFirst({ where: { id: labelId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateLabelSchema.parse(await request.json());
    const nextName = data.name?.trim();

    const result = await prisma.$transaction(async (tx) => {
      // Every item that carries EITHER label needs its mirror rebuilt: the ones
      // on this label because its name changes, and (on a merge) the ones on the
      // target because this label's items join them.
      const touched = new Set<string>();
      const own = await tx.workItemLabel.findMany({
        where: { labelId },
        select: { workItemId: true },
      });
      own.forEach((r) => touched.add(r.workItemId));

      let survivingId = labelId;
      let merged = false;

      if (nextName && nextName.toLowerCase() !== existing.name.toLowerCase()) {
        const clash = await tx.label.findFirst({
          where: { orgId, name: { equals: nextName, mode: "insensitive" } },
        });

        if (clash && clash.id !== labelId) {
          // Merge. skipDuplicates covers items already carrying both.
          await tx.workItemLabel.createMany({
            data: own.map((r) => ({ orgId, workItemId: r.workItemId, labelId: clash.id })),
            skipDuplicates: true,
          });
          await tx.label.delete({ where: { id: labelId } });
          survivingId = clash.id;
          merged = true;
        } else {
          await tx.label.update({ where: { id: labelId }, data: { name: nextName } });
        }
      }

      if (!merged && data.color !== undefined) {
        await tx.label.update({ where: { id: labelId }, data: { color: data.color } });
      }

      await recomputeTagMirror(tx, [...touched]);
      return {
        label: await tx.label.findUniqueOrThrow({ where: { id: survivingId } }),
        merged,
        itemsTouched: touched.size,
      };
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: result.merged ? "label.merge" : "label.update",
      entity: "label",
      entityId: result.label.id,
      metadata: {
        from: existing.name,
        to: result.label.name,
        itemsTouched: result.itemsTouched,
      },
      ipAddress: getIpAddress(request),
    });

    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Delete a label everywhere.
 *
 * The join rows go by cascade, but cascade knows nothing about the `tags`
 * mirror — so the affected items are collected FIRST and their arrays rebuilt
 * after, or the deleted label would linger on the RAID board and in every
 * consumer still reading tags.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, labelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    const existing = await prisma.label.findFirst({ where: { id: labelId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const itemsTouched = await prisma.$transaction(async (tx) => {
      const affected = await tx.workItemLabel.findMany({
        where: { labelId },
        select: { workItemId: true },
      });
      await tx.label.delete({ where: { id: labelId } });
      const ids = affected.map((r) => r.workItemId);
      await recomputeTagMirror(tx, ids);
      return ids.length;
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "label.delete",
      entity: "label",
      entityId: labelId,
      metadata: { name: existing.name, itemsTouched },
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
