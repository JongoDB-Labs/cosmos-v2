import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { getMeetClient } from "@/lib/integrations/google";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; meetingId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.syncMeeting.findFirst({ where: { id: meetingId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await requireAccess(ctx, "MEETING_UPDATE", {
      createdById: existing.createdById,
      projectId: existing.projectId,
    });

    let space;
    try {
      const meet = await getMeetClient(ctx.userId, orgId);
      const res = await meet.spaces.create({ requestBody: {} });
      space = res.data;
    } catch (err) {
      // Missing token or insufficient Meet scope → ask the user to reconnect.
      // Anything else (network, 5xx, quota) is a real error — let handleApiError surface it.
      const status =
        (err as { code?: number })?.code ?? (err as { status?: number })?.status;
      const msg = err instanceof Error ? err.message : "";
      const isAuth =
        status === 401 || status === 403 ||
        /refresh token|not connected|invalid_grant|insufficient|unauthor/i.test(msg);
      if (isAuth) {
        return Response.json(
          { error: "Reconnect Google to enable Meet (missing Google Meet access).", reconnect: "/api/auth/google" },
          { status: 409 },
        );
      }
      throw err;
    }

    const updated = await prisma.syncMeeting.update({
      where: { id: meetingId },
      data: {
        meetingUrl: space?.meetingUri ?? null,
        videoProvider: "GOOGLE_MEET",
        meetSpaceName: space?.name ?? null,
      },
      include: { attendees: true },
    });

    await logAudit({
      orgId, userId: ctx.userId,
      action: "meeting.meet_created", entity: "sync_meeting", entityId: meetingId,
      metadata: { space: space?.name ?? "" } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
