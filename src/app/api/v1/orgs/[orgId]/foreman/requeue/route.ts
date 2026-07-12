import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ConflictError, ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { syncFeedbackForWorkItems } from "@/lib/feedback/status-sync";

type RouteParams = { params: Promise<{ orgId: string }> };

const requeueSchema = z.object({ workItemId: z.string().uuid() });

/** The Foreman BOT user — see scripts/foreman/db.mts FOREMAN_BOT_EMAIL. Comments
 *  posted from this console read as coming from the same agent identity as the
 *  daemon's own board moves. */
const FOREMAN_BOT_EMAIL = "foreman@cosmos.internal";

/** Foreman console "requeue" control: pulls a ticket the daemon parked in
 *  `review` back to `backlog` for another pass — the human-triggered equivalent
 *  of an `@Foreman requeue` mention. Same gate as the rest of the console
 *  (ORG_UPDATE, checked via the automation config's owner/admin surface). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);
    // Steering the deployer is a BASE OWNER/ADMIN privilege (matches the daemon's
    // privilegedUserIds gate + the console's actorCanSteer) — a work-role that
    // widens ORG_UPDATE onto a MEMBER must NOT be able to requeue a parked build.
    if (ctx.orgRole !== OrgRole.OWNER && ctx.orgRole !== OrgRole.ADMIN) {
      throw new ForbiddenError("steering the delivery agent requires the Owner or Admin base role");
    }

    const { workItemId } = requeueSchema.parse(await request.json());

    // Scoping the lookup to `orgId` makes this 404 cover both a nonexistent
    // item AND one that belongs to a different org — a foreign id can never
    // leak column/existence info cross-tenant.
    const item = await prisma.workItem.findFirst({
      where: { id: workItemId, orgId },
      select: { id: true, columnKey: true },
    });
    if (!item) return new Response("Not found", { status: 404 });
    if (item.columnKey !== "review") {
      throw new ConflictError("Only items awaiting review can be requeued.");
    }

    await prisma.workItem.update({
      where: { id: workItemId },
      data: { columnKey: "backlog", columnEnteredAt: new Date() },
    });
    // Carries the linked feedback item's status back with the board move —
    // reporters watch feedback, not the board (same contract as every other
    // column-writing path; see src/lib/feedback/status-sync.ts).
    await syncFeedbackForWorkItems([workItemId]);

    const [bot, actor] = await Promise.all([
      prisma.user.findFirst({ where: { email: FOREMAN_BOT_EMAIL }, select: { id: true } }),
      prisma.user.findUnique({ where: { id: ctx.userId }, select: { displayName: true } }),
    ]);
    const displayName = actor?.displayName ?? "Someone";

    await prisma.comment.create({
      data: {
        orgId,
        workItemId,
        authorId: bot?.id ?? ctx.userId,
        content: `Requeued by ${displayName} from the Foreman console.`,
      },
    });

    await prisma.foremanEvent.create({
      data: {
        orgId,
        workItemId,
        ticketKey: null,
        kind: "requeued",
        severity: "info",
        message: `requeued from the Foreman console by ${displayName}`,
      },
    });

    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
