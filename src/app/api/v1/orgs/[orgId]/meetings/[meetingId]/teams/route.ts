import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { meetingReader } from "@/lib/meetings/meeting-reader";
import { TEAMS_REFUSED } from "@/lib/meetings/teams-messages";
import { success, handleApiError } from "@/lib/api-helpers";
import { TeamsRefused, setMeetingTeams, teamsPreview, type TeamsPreview } from "@/lib/integrations/microsoft/calendar-sync.server";

type RouteParams = { params: Promise<{ orgId: string; meetingId: string }> };

/** The preview as both handlers answer it: with the host's name to show. */
async function withHostName(preview: TeamsPreview) {
  const host = preview.hostId
    ? await prisma.user.findUnique({ where: { id: preview.hostId }, select: { displayName: true, email: true } })
    : null;
  return { ...preview, hostName: host ? host.displayName || host.email : null };
}

/**
 * A meeting's Teams meeting, as the signed-in person: whether it is one, its
 * join link, whose Outlook holds it, and whether they may turn it on or off.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    // A meeting hidden from the caller answers as a missing one: no join link.
    const r = await meetingReader(orgId, meetingId);
    if (!r) return new Response("Not found", { status: 404 });
    if (r.ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const preview = await teamsPreview(orgId, meetingId, r.ctx.userId);
    if (!preview) return new Response("Not found", { status: 404 });
    return success(await withHostName(preview));
  } catch (error) {
    return handleApiError(error);
  }
}

const body = z.object({ enabled: z.boolean() });

/** Make the meeting a Teams meeting, held in your own Outlook, or stop it being one. */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const r = await meetingReader(orgId, meetingId);
    if (!r) return new Response("Not found", { status: 404 });
    // The Teams meeting is made in a person's own mailbox: never on an API key.
    if (r.ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const { enabled } = body.parse(await request.json());
    try {
      await setMeetingTeams(orgId, meetingId, r.ctx.userId, enabled);
    } catch (e) {
      if (e instanceof TeamsRefused) {
        const [status, error] = TEAMS_REFUSED[e.reason];
        return new Response(JSON.stringify({ error, reason: e.reason }), { status, headers: { "Content-Type": "application/json" } });
      }
      throw e;
    }
    const preview = await teamsPreview(orgId, meetingId, r.ctx.userId);
    if (!preview) return new Response("Not found", { status: 404 });
    return success(await withHostName(preview));
  } catch (error) {
    return handleApiError(error);
  }
}
