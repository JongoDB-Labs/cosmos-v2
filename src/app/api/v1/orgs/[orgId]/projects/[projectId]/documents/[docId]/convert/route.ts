import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { convertBlockToWorkItem } from "@/lib/files/convert";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

const schema = z.object({
  blockId: z.string().uuid(),
  title: z.string().max(500).optional(),
  columnKey: z.string().optional(),
});

/** POST — convert a document block into a Work Item (Issue) + a source link. */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_CREATE);

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      select: { id: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    const { blockId, title, columnKey } = schema.parse(await req.json());
    const result = await convertBlockToWorkItem({
      orgId,
      projectId,
      blockId,
      userId: ctx.userId,
      title,
      columnKey,
    });
    return success(result, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
