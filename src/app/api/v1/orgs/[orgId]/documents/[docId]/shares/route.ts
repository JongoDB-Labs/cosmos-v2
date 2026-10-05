import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { readableDocument, canManageDocument } from "@/lib/files/access";
import { uploadersByIds, FORMER_MEMBER } from "@/lib/files/uploader";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; docId: string }> };

const postSchema = z.object({ userId: z.string().uuid() });

/**
 * Who a restricted file has been shared with.
 *
 * Managing the list is the same right as managing the file — the uploader, or
 * whoever runs the project it sits on. Reading it is too: the list of people a
 * file was shared with is itself a disclosure ("who else is looking at this"), so
 * it is not offered to everybody who happens to have been granted the file.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const doc = await readableDocument(orgId, docId, ctx);
    if (!doc) return new Response("Not found", { status: 404 });
    if (!(await canManageDocument(doc, ctx)))
      return new Response("Only whoever looks after this file can see who it is shared with", {
        status: 403,
      });

    const rows = await prisma.documentShare.findMany({
      where: { orgId, documentId: docId },
      select: { id: true, userId: true, grantedById: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const people = await uploadersByIds(rows.flatMap((r) => [r.userId, r.grantedById]));
    return success(
      rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        user: people.get(r.userId) ?? { id: r.userId, ...FORMER_MEMBER },
        grantedBy: people.get(r.grantedById) ?? { id: r.grantedById, ...FORMER_MEMBER },
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

/** POST — share it with one more person. Idempotent: re-sharing is not a second row. */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const doc = await readableDocument(orgId, docId, ctx);
    if (!doc) return new Response("Not found", { status: 404 });
    if (!(await canManageDocument(doc, ctx)))
      return new Response("You did not upload this file and cannot share it", { status: 403 });

    const { userId } = postSchema.parse(await req.json());

    // Only somebody who is actually in this org. Without this the grant table
    // becomes a way to probe which user ids exist anywhere in the system, and a
    // share to a stranger is a row that will never do anything useful.
    const member = await prisma.orgMember.findFirst({
      where: { orgId, userId },
      select: { id: true },
    });
    if (!member) return new Response("That person is not in this organization", { status: 400 });

    const share = await prisma.documentShare.upsert({
      where: { documentId_userId: { documentId: docId, userId } },
      create: { orgId, documentId: docId, userId, grantedById: ctx.userId },
      update: {},
      select: { id: true, userId: true, grantedById: true, createdAt: true },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "document.share",
      entity: "Document",
      entityId: docId,
      metadata: { sharedWith: userId, projectId: doc.projectId },
    });

    const people = await uploadersByIds([share.userId, share.grantedById]);
    return success(
      {
        id: share.id,
        createdAt: share.createdAt,
        user: people.get(share.userId) ?? { id: share.userId, ...FORMER_MEMBER },
        grantedBy: people.get(share.grantedById) ?? { id: share.grantedById, ...FORMER_MEMBER },
      },
      201,
    );
  } catch (e) {
    return handleApiError(e);
  }
}
