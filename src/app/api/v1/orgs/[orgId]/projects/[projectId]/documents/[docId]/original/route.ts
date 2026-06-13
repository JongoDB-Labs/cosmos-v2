import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { getStorage } from "@/lib/storage";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

/** Stream the stored ORIGINAL file (for "view original" — PDF inline, others download). */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { orgId, projectId, docId } = await params;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  requirePermission(ctx, Permission.PROJECT_READ);

  const doc = await prisma.document.findFirst({
    where: { id: docId, orgId, projectId },
    select: { storageKey: true, contentType: true, filename: true },
  });
  if (!doc) return new Response("Not found", { status: 404 });

  const stream = await getStorage().stream(doc.storageKey);
  if (!stream) return new Response("File not found", { status: 404 });

  return new Response(stream, {
    headers: {
      "Content-Type": doc.contentType || "application/octet-stream",
      // inline so PDFs render in an <iframe>; the filename guides downloads.
      "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
