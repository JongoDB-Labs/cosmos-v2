import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { getMeetClient } from "@/lib/integrations/google";
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

    const existing = await prisma.syncMeeting.findFirst({ where: { id: meetingId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });
    await requireAccess(ctx, "MEETING_UPDATE", {
      createdById: existing.createdById,
      projectId: existing.projectId,
    });
    if (!existing.meetSpaceName) {
      return Response.json({ error: "This meeting has no Google Meet space." }, { status: 400 });
    }

    const meet = await getMeetClient(ctx.userId, orgId);
    const recordsRes = await meet.conferenceRecords.list({
      filter: `space.name="${existing.meetSpaceName}"`,
    });
    const record = recordsRes.data.conferenceRecords?.[0];
    if (!record?.name) {
      return success({
        ready: false,
        message:
          "Artifacts aren't available yet — they appear after the meeting ends and Google finishes processing.",
      });
    }

    const participantsRes = await meet.conferenceRecords.participants.list({ parent: record.name });
    const nameByResource = new Map<string, string | null>(
      (participantsRes.data.participants ?? []).map((p) => [
        p.name ?? "",
        p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? null,
      ]),
    );

    let transcriptText = existing.transcript ?? "";
    const transcripts = await meet.conferenceRecords.transcripts.list({ parent: record.name });
    const firstTranscript = transcripts.data.transcripts?.[0];
    if (firstTranscript?.name) {
      const entriesRes = await meet.conferenceRecords.transcripts.entries.list({ parent: firstTranscript.name });
      const lines = (entriesRes.data.transcriptEntries ?? []).map((e) => {
        const speaker = nameByResource.get(e.participant ?? "") ?? "Speaker";
        return `${speaker}: ${e.text ?? ""}`;
      });
      if (lines.length) transcriptText = lines.join("\n");
    }

    const recordingsRes = await meet.conferenceRecords.recordings.list({ parent: record.name });

    const artifacts = {
      conferenceName: record.name,
      recordings: (recordingsRes.data.recordings ?? []).map((r) => ({
        name: r.name ?? null,
        driveFileId: r.driveDestination?.file ?? null,
      })),
      participants: (participantsRes.data.participants ?? []).map((p) => ({
        name: p.name ?? null,
        displayName:
          p.signedinUser?.displayName ??
          p.anonymousUser?.displayName ??
          p.phoneUser?.displayName ??
          null,
      })),
      syncedAt: new Date().toISOString(),
    };

    const updated = await prisma.syncMeeting.update({
      where: { id: meetingId },
      data: {
        transcript: transcriptText,
        meetConferenceName: record.name,
        artifacts: artifacts as Prisma.InputJsonValue,
      },
      include: { attendees: true },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting.artifacts_synced",
      entity: "sync_meeting",
      entityId: meetingId,
      metadata: {
        recordings: String(artifacts.recordings.length),
        participants: String(artifacts.participants.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ ready: true, meeting: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
