import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { InviteRefused, invitePreview, setMeetingInvite } from "@/lib/integrations/microsoft/calendar-sync.server";

type RouteParams = { params: Promise<{ orgId: string; meetingId: string }> };

async function resolve(orgId: string, meetingId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return null;
  requirePermission(ctx, Permission.MEETING_READ);
  const meeting = await prisma.syncMeeting.findFirst({ where: { id: meetingId, orgId }, select: { id: true } });
  return meeting ? { org, ctx } : null;
}

/**
 * COSMOS-202 B2 invite mode: whether this meeting's Outlook invitations are on,
 * who sends them, and what turning them on would do (who'd be invited, who is
 * outside the org's domains), as the signed-in person.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const r = await resolve(orgId, meetingId);
    if (!r) return new Response("Not found", { status: 404 });
    if (r.ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const preview = await invitePreview(orgId, meetingId, r.ctx.userId);
    if (!preview) return new Response("Not found", { status: 404 });
    const organizer = preview.organizerId
      ? await prisma.user.findUnique({ where: { id: preview.organizerId }, select: { displayName: true, email: true } })
      : null;
    return success({ ...preview, organizerName: organizer ? organizer.displayName || organizer.email : null });
  } catch (error) {
    return handleApiError(error);
  }
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
    const r = await resolve(orgId, meetingId);
    if (!r) return new Response("Not found", { status: 404 });
    // Invitations go out from a person's own mailbox: never on an API key.
    if (r.ctx.isApiKey) return new Response("Forbidden", { status: 403 });
    const { enabled } = body.parse(await request.json());
    try {
      await setMeetingInvite(orgId, meetingId, r.ctx.userId, enabled);
    } catch (e) {
      if (e instanceof InviteRefused) {
        const [status, error] = REFUSED[e.reason] ?? [409, "That isn't possible right now."];
        return new Response(JSON.stringify({ error, reason: e.reason }), { status, headers: { "Content-Type": "application/json" } });
      }
      throw e;
    }
    return success(await invitePreview(orgId, meetingId, r.ctx.userId));
  } catch (error) {
    return handleApiError(error);
  }
}
