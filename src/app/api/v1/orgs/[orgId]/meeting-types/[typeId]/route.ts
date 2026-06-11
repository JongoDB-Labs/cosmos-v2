import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; typeId: string }> };

/**
 * Delete an org-defined meeting type. Meetings that used it fall back to their
 * built-in MeetingType (the FK is ON DELETE SET NULL), so no meeting is lost.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Deleting org-wide meeting vocabulary is destructive (every meeting that
    // referenced this type silently loses its custom label via the SetNull FK),
    // so it must be admin-gated — MEETING_DELETE, not the MEMBER-level
    // MEETING_CREATE used by the POST that creates a type.
    requirePermission(ctx, Permission.MEETING_DELETE);

    const existing = await prisma.meetingTypeOption.findFirst({
      where: { id: typeId, orgId },
      select: { id: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.meetingTypeOption.delete({ where: { id: typeId } });
    return success({ id: typeId, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
