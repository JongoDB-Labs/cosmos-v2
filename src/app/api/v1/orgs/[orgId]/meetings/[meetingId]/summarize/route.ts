import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { runAgentLoop } from "@/lib/ai/agent-loop";
import { parseSummaryJson, SUMMARY_SYSTEM_PROMPT } from "@/lib/meetings/summarize";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; meetingId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId }, include: { attendees: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });
    await requireAccess(ctx, "MEETING_UPDATE", {
      createdById: existing.createdById, projectId: existing.projectId,
    });

    const contentfulAttendees = existing.attendees.filter(
      (a) => a.doneSinceLast?.trim() || a.workingOn?.trim() || a.blockers?.trim(),
    );
    const attendeeBlock = contentfulAttendees
      .map((a) => `- done: ${a.doneSinceLast}; doing: ${a.workingOn}; blockers: ${a.blockers}`)
      .join("\n");

    if (!existing.notes?.trim() && !existing.transcript?.trim() && contentfulAttendees.length === 0) {
      return Response.json({ error: "Nothing to summarize yet — add notes or sync a transcript first." }, { status: 400 });
    }

    const userPrompt =
      `Meeting: ${existing.title || "(untitled)"}\n\n` +
      `Notes:\n${existing.notes || "(none)"}\n\n` +
      `Attendee updates:\n${attendeeBlock || "(none)"}\n\n` +
      `Transcript:\n${existing.transcript || "(none)"}`;

    // One-shot text completion (no tools) through the single egress path.
    const result = await runAgentLoop({
      orgId,
      userId: ctx.userId,
      // fail-closed: only an explicit COMMERCIAL org gets the permissive class.
      tenantClass: org.tenantClass === "COMMERCIAL" ? "commercial" : "gov",
      conversationId: `meeting:${meetingId}`,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      initialPrompt: userPrompt,
      tools: [],
    });
    let parsed;
    try {
      parsed = parseSummaryJson(result.text);
    } catch {
      return Response.json({ error: "The AI returned an unexpected response — please try again." }, { status: 502 });
    }

    const updated = await prisma.syncMeeting.update({
      where: { id: meetingId },
      data: {
        aiSummary: parsed.summary,
        aiTickets: parsed.tickets as unknown as Prisma.InputJsonValue,
      },
      include: { attendees: true },
    });

    await logAudit({
      orgId, userId: ctx.userId,
      action: "meeting.summarized", entity: "sync_meeting", entityId: meetingId,
      metadata: { tickets: String(parsed.tickets.length) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
