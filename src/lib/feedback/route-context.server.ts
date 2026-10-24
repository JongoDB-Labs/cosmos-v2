import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, type AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { isFeedbackStaff } from "./access";
import { markingCeiling, type CommentViewer } from "./comments.server";
import { inVisibleProject } from "@/lib/rbac/require-project-read";

export interface FeedbackRouteContext {
  org: { id: string; slug: string };
  ctx: AuthContext;
  viewer: CommentViewer;
  item: {
    id: string;
    title: string;
    authorId: string;
    status: string;
    lockedAt: Date | null;
    mergedIntoId: string | null;
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The checks every feedback-discussion route starts with: the org exists, the
 * caller is signed in and can read the board, and the item is in this org.
 * Returns a Response to send back as-is when any of them fails.
 */
export async function loadFeedbackRoute(
  orgId: string,
  feedbackId: string,
): Promise<FeedbackRouteContext | Response> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) return new Response("Not found", { status: 404 });

  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  requirePermission(ctx, Permission.ORG_READ);

  const item = await prisma.feedbackItem.findFirst({
    where: { id: feedbackId, orgId },
    select: { id: true, title: true, authorId: true, status: true, lockedAt: true, mergedIntoId: true, projectId: true },
  });
  // A team-scoped project's feedback is the same 404 as a missing one to anyone
  // who can't see the project.
  if (!item || !(await inVisibleProject(ctx, item.projectId))) return new Response("Not found", { status: 404 });

  return {
    org,
    ctx,
    item,
    viewer: { userId: ctx.userId, isStaff: isFeedbackStaff(ctx), markingCeiling: await markingCeiling(org.id) },
  };
}

/**
 * Why a write to this thread is refused, if it is: the item was merged (the
 * discussion lives on the survivor), or the thread is locked (staff only).
 * MERGED counts even without a pointer: deleting the survivor nulls
 * `mergedIntoId` (ON DELETE SET NULL), and that must not reopen the thread.
 */
export function threadWriteBlock(route: FeedbackRouteContext): Response | null {
  if (route.item.mergedIntoId || route.item.status === "MERGED") {
    return json(409, {
      error: "This request was merged into another one; continue the discussion there.",
      mergedIntoId: route.item.mergedIntoId,
    });
  }
  if (route.item.lockedAt && !route.viewer.isStaff) {
    return json(423, { error: "Comments are closed on this request." });
  }
  return null;
}

export { json };
