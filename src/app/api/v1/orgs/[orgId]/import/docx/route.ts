import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import mammoth from "mammoth";

type RouteParams = { params: Promise<{ orgId: string }> };

// cacheComponents enabled: `runtime` segment config not supported (Node is default).

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_IMPORT);

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response("Missing or invalid multipart body", { status: 400 });
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response("Missing file field", { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return new Response("File too large (max 10MB)", { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await mammoth.convertToHtml({ buffer });

    return success({
      html: result.value,
      messages: result.messages,
      filename: file.name,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
