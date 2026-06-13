import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { ingestDocument } from "@/lib/files/ingest";
import { formatFromName } from "@/lib/files/parsers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const docs = await prisma.document.findMany({
      where: { orgId, projectId },
      select: {
        id: true, title: true, filename: true, format: true, status: true,
        pageCount: true, size: true, classificationLevel: true, contentType: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return success(docs);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);
    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return new Response("Missing file field", { status: 400 });
    if (!formatFromName(file.name)) return new Response("Unsupported file type", { status: 400 });

    const doc = await ingestDocument({
      orgId,
      projectId,
      uploadedById: ctx.userId,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    return success(doc, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
