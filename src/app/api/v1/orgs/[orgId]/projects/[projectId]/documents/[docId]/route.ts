import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      include: { blocks: { orderBy: { ordinal: "asc" } } },
    });
    if (!doc) return new Response("Not found", { status: 404 });
    return success(doc);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      select: { id: true, storageKey: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });
    await getStorage().delete(doc.storageKey).catch(() => {});
    await prisma.document.delete({ where: { id: doc.id } });
    return success({ id: doc.id });
  } catch (e) {
    return handleApiError(e);
  }
}
