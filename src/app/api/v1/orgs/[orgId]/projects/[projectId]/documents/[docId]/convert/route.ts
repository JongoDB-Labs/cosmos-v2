import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { convertBlockToItem, convertTableToWorkItems } from "@/lib/files/convert";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

const schema = z.object({
  blockId: z.string().uuid(),
  title: z.string().max(500).optional(),
  columnKey: z.string().optional(),
  itemType: z
    .enum(["ISSUE", "MILESTONE", "OBJECTIVE", "GOAL", "INTERVAL", "ROADMAP_NODE"])
    .default("ISSUE"),
  // When present, map a TABLE block's rows -> one Issue each (CSV-style).
  table: z.object({ titleColumn: z.number().int().min(0), headerRow: z.boolean() }).optional(),
});

/** POST — convert a document block into a project item (Issue / Milestone / OKR /
 *  Goal / Sprint / Roadmap node) + a source link. With `table`, maps a TABLE
 *  block's rows to one Issue each. */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_CREATE);

    const doc = await prisma.document.findFirst({
      where: { id: docId, orgId, projectId },
      select: { id: true },
    });
    if (!doc) return new Response("Not found", { status: 404 });

    const { blockId, title, columnKey, itemType, table } = schema.parse(await req.json());
    if (table) {
      const result = await convertTableToWorkItems({
        orgId,
        projectId,
        blockId,
        userId: ctx.userId,
        titleColumn: table.titleColumn,
        headerRow: table.headerRow,
        columnKey,
      });
      return success({ kind: "table", ...result }, 201);
    }
    const result = await convertBlockToItem({
      orgId,
      projectId,
      blockId,
      userId: ctx.userId,
      itemType,
      title,
      columnKey,
    });
    return success(result, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
