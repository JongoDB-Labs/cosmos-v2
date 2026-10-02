import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { readableDocument } from "@/lib/files/access";
import { uploadersByIds, FORMER_MEMBER } from "@/lib/files/uploader";

type RouteParams = { params: Promise<{ orgId: string; docId: string }> };

/** The polymorphic subject key for a file. Written once, read in both verbs. */
const SUBJECT = "document";

const postSchema = z.object({ content: z.string().trim().min(1).max(10_000) });

/**
 * Comments on a file.
 *
 * No new table: `Comment` is already polymorphic on (subjectType, subjectId) and
 * indexed on it. One route rather than hanging this off the project-scoped
 * pm-comments door as well, because a document may belong to NO project — an
 * org-wide template or certificate — and a second door onto the same rows is how
 * the two drift apart.
 *
 * Who may read a comment is who may read the file, deliberately. A comment on a
 * drawing can name the problem with the drawing, so it is exactly as sensitive as
 * the thing it is attached to, and anything looser would route around the
 * project scoping the file itself obeys.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    if (!(await readableDocument(orgId, docId, ctx)))
      return new Response("Not found", { status: 404 });

    const rows = await prisma.comment.findMany({
      where: { orgId, subjectType: SUBJECT, subjectId: docId },
      select: { id: true, content: true, authorId: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Same batched resolution as the file list: authorId has no foreign key for
    // the same reason uploadedById does not — a comment outlives the account.
    const byId = await uploadersByIds(rows.map((r) => r.authorId));
    return success(
      rows.map(({ authorId, ...rest }) => ({
        ...rest,
        author: byId.get(authorId) ?? { id: authorId, ...FORMER_MEMBER },
        // So the client can offer a delete control without a second round trip.
        mine: authorId === ctx.userId,
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * POST — say something about this file.
 *
 * Gated on READ, not on the right to change the file. Commenting is how somebody
 * who may look at a drawing but not alter it says what is wrong with it, and
 * requiring write access would silence exactly the people the thread is for.
 */
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

    const { content } = postSchema.parse(await req.json());
    const row = await prisma.comment.create({
      data: { orgId, subjectType: SUBJECT, subjectId: docId, authorId: ctx.userId, content },
      select: { id: true, content: true, authorId: true, createdAt: true, updatedAt: true },
    });

    const byId = await uploadersByIds([row.authorId]);
    const { authorId, ...rest } = row;
    return success(
      {
        ...rest,
        author: byId.get(authorId) ?? { id: authorId, ...FORMER_MEMBER },
        mine: true,
      },
      201,
    );
  } catch (e) {
    return handleApiError(e);
  }
}
