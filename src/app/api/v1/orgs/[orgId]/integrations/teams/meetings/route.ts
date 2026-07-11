import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { scheduleTeamsMeeting, listTeamsMeetings } from "@/lib/integrations/teams-meetings";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Map a Teams-meetings lib error to an HTTP status. A "not connected" error means
 * the org hasn't linked an M365 tenant yet → 409 so the UI can prompt an admin to
 * install the Microsoft 365 integration. Any other Graph-side failure (insufficient
 * permission, upstream error) is an upstream-dependency failure → 502.
 */
function graphErrorStatus(error: string): number {
  return /not connected/i.test(error) ? 409 : 502;
}

const attendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  type: z.enum(["required", "optional"]).optional(),
});

const scheduleSchema = z.object({
  organizer: z.string().min(1, "An organizer (M365 user id or UPN) is required"),
  subject: z.string().min(1, "A subject is required"),
  start: z.string().min(1, "A start time is required"),
  end: z.string().min(1, "An end time is required"),
  timeZone: z.string().optional(),
  bodyHtml: z.string().optional(),
  attendees: z.array(attendeeSchema).optional(),
});

/**
 * List the linked M365 tenant's Teams meetings for an organizer mailbox (COSMOS-48).
 * Tenant-scoped: the lib resolves the org's OWN sealed credential, so only meetings
 * on the linked tenant are ever returned. Gated on MEETING_READ.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_READ);

    const sp = request.nextUrl.searchParams;
    const organizer = sp.get("organizer")?.trim();
    if (!organizer) {
      return success({ error: "An organizer query param (M365 user id or UPN) is required." }, 400);
    }
    const topRaw = sp.get("top");
    const top = topRaw ? Number(topRaw) : undefined;

    const result = await listTeamsMeetings(orgId, { organizer, top });
    if (!result.ok) return success({ error: result.error }, graphErrorStatus(result.error));

    return success({ meetings: result.meetings });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Schedule a new Teams meeting on the linked M365 tenant (COSMOS-48) — it appears on
 * the organizer's calendar and attendees are invited. Gated on MEETING_CREATE.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_CREATE);

    const body = await request.json();
    const input = scheduleSchema.parse(body);

    const result = await scheduleTeamsMeeting(orgId, input);
    if (!result.ok) return success({ error: result.error }, graphErrorStatus(result.error));

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "teams_meeting.scheduled",
      entity: "teams_meeting",
      entityId: result.meeting.id,
      metadata: { subject: result.meeting.subject, organizer: input.organizer } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created({ meeting: result.meeting });
  } catch (error) {
    return handleApiError(error);
  }
}
