import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { meetingReader } from "@/lib/meetings/meeting-reader";
import { success, handleApiError } from "@/lib/api-helpers";
import { InviteRefused, invitePreview, setMeetingInvite, type InvitePreview } from "@/lib/integrations/microsoft/calendar-sync.server";
import { teamsHostedMessage } from "@/lib/meetings/teams-messages";

type RouteParams = { params: Promise<{ orgId: string; meetingId: string }> };

/**
 * COSMOS-202 B2 invite mode: whether this meeting's Outlook invitations are on,
 * who sends them, and what turning them on would do (who'd be invited, who is
 * outside the org's domains), as the signed-in person.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    // A meeting hidden from the caller answers as a missing one.
    const r = await meetingReader(orgId, meetingId);
    if (!r) return new Response("Not found", { status: 404 });
    if (r.ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const preview = await invitePreview(orgId, meetingId, r.ctx.userId);
    if (!preview) return new Response("Not found", { status: 404 });
    return success(await withOrganizerName(preview));
  } catch (error) {
    return handleApiError(error);
  }
}

/** A person's name to show, or null for nobody. */
async function nameOf(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, email: true } });
  return u ? u.displayName || u.email : null;
}

/** The preview as both handlers answer it: with the organizer's and the Teams host's names to show. */
async function withOrganizerName(preview: InvitePreview) {
  const [organizerName, teamsHostName] = await Promise.all([nameOf(preview.organizerId), nameOf(preview.teamsHostId)]);
  return { ...preview, organizerName, teamsHostName };
}


const body = z.object({ enabled: z.boolean() });

const REFUSED: Record<string, [number, string]> = {
  rate_limited: [429, "You've changed Outlook invitations too often. Try again later."],
  not_found: [404, "Not found"],
  cannot_edit: [403, "Only someone who can edit this meeting can change its invitations."],
  already_on: [409, "Invitations are already being sent by someone else. They need to turn them off first."],
  classified: [409, "Classified meetings can't send Outlook invitations."],
  not_connected: [409, "Connect your Outlook Calendar first (Settings, Preferences)."],
  reconnect: [409, "Reconnect your Outlook Calendar first (Settings, Preferences)."],
  too_many_attendees: [409, "Outlook invitations are limited to 100 attendees."],
  cancelled: [409, "This meeting is cancelled."],
};

/** Turn the meeting's Outlook invitations on (you become the organizer) or off. */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    // A meeting hidden from the caller answers as a missing one.
    const r = await meetingReader(orgId, meetingId);
    if (!r) return new Response("Not found", { status: 404 });
    // Invitations go out from a person's own mailbox: never on an API key.
    if (r.ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const { enabled } = body.parse(await request.json());
    try {
      await setMeetingInvite(orgId, meetingId, r.ctx.userId, enabled);
    } catch (e) {
      if (e instanceof InviteRefused) {
        const [status, error] = e.reason === "teams_hosted_by_someone_else"
          ? [409, teamsHostedMessage(await nameOf(e.hostId))]
          : REFUSED[e.reason] ?? [409, "That isn't possible right now."];
        return new Response(JSON.stringify({ error, reason: e.reason }), { status, headers: { "Content-Type": "application/json" } });
      }
      throw e;
    }
    const preview = await invitePreview(orgId, meetingId, r.ctx.userId);
    if (!preview) return new Response("Not found", { status: 404 });
    return success(await withOrganizerName(preview));
  } catch (error) {
    return handleApiError(error);
  }
}
