import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { uploadersByIds, FORMER_MEMBER } from "@/lib/files/uploader";
import { getFeedbackComment } from "@/lib/feedback/comments.server";
import { loadFeedbackRoute } from "@/lib/feedback/route-context.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string; commentId: string }> };

/**
 * A comment's edit history, newest first: what it said before each edit. Open
 * to anyone who can see the comment (GitHub's rule). A redacted revision keeps
 * only who and when.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId, commentId } = await params;
    const route = await loadFeedbackRoute(orgId, feedbackId);
    if (route instanceof Response) return route;

    const comment = await getFeedbackComment(orgId, feedbackId, commentId, route.viewer);
    if (!comment || comment.deletedAt) return new Response("Not found", { status: 404 });

    const revisions = await prisma.commentRevision.findMany({
      where: { commentId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, content: true, editedById: true, redactedAt: true, createdAt: true },
    });
    const editors = await uploadersByIds(revisions.map((r) => r.editedById));
    return success(
      revisions.map((r) => ({
        id: r.id,
        content: r.redactedAt ? null : r.content,
        redacted: r.redactedAt !== null,
        editedBy: editors.get(r.editedById) ?? { id: r.editedById, ...FORMER_MEMBER },
        createdAt: r.createdAt,
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
