import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { syncMeetingSoon, teamsRefusalForNew } from "@/lib/integrations/microsoft/calendar-sync.server";
import { ATTENDEES_NOT_MEMBERS, allOrgMembers, attendeesNotMembers } from "./attendee-members";
import { TEAMS_REFUSED, type TeamsRefusal } from "./teams-messages";

/** What the caller wants back, in Prisma's own terms. A `select` must include the id the push needs. */
type MeetingShape =
  | { select: Prisma.SyncMeetingSelect & { id: true } }
  | { include: Prisma.SyncMeetingInclude };

/** A new meeting, and who it reaches. */
export interface NewMeeting {
  /** The row, less the two things decided here: its attendees and its Teams host. */
  data: Omit<Prisma.SyncMeetingUncheckedCreateInput, "attendees" | "teamsHostId">;
  /** People in the meeting's org. Each gets it in their Outlook once they've connected it. */
  attendeeIds?: string[];
  /** A Teams meeting, held in the creator's own Outlook. */
  teamsMeeting?: boolean;
  /** The creator is an API key: a Teams meeting is made in a person's mailbox, so never on one. */
  isApiKey?: boolean;
}

/** Why a meeting wasn't made. Nothing was saved and nothing pushed. */
export type MeetingRefusal =
  | { kind: "attendees_not_members" }
  | { kind: "teams_on_api_key" }
  | { kind: "teams"; reason: TeamsRefusal };

/**
 * Create a meeting, then push it to Outlook: the one create path, for the app
 * and for Cosmo alike, so the two can't drift on who a meeting reaches or what
 * is refused. Attendees must be in the org; a Teams meeting is refused (before
 * anything is saved) where the creator couldn't hold it. The push is
 * fire-and-forget, as every push is (`syncMeetingSoon`), so a slow or failing
 * Microsoft never fails the create. It writes to the Outlook of the attendees
 * who've connected it and of a Teams meeting's host; a meeting with neither
 * reaches nobody's calendar, wherever it was made.
 * `create-meeting.arch.test.ts` keeps other creates of a meeting out of the app.
 */
export async function createSyncMeeting<S extends MeetingShape>(
  m: NewMeeting,
  shape: S,
): Promise<{ meeting: Prisma.SyncMeetingGetPayload<S>; refused?: never } | { refused: MeetingRefusal; meeting?: never }> {
  const { orgId, createdById } = m.data;
  const attendeeIds = [...new Set(m.attendeeIds ?? [])];
  if (!(await allOrgMembers(orgId, attendeeIds))) return { refused: { kind: "attendees_not_members" } };
  if (m.teamsMeeting) {
    if (m.isApiKey) return { refused: { kind: "teams_on_api_key" } };
    const reason = await teamsRefusalForNew(orgId, createdById, { projectId: m.data.projectId ?? null, title: m.data.title ?? "" }); // the column's default
    if (reason) return { refused: { kind: "teams", reason } };
  }
  const data: Prisma.SyncMeetingUncheckedCreateInput = {
    ...m.data,
    ...(m.teamsMeeting && { teamsHostId: createdById }),
    ...(attendeeIds.length > 0 && { attendees: { create: attendeeIds.map((userId) => ({ userId })) } }),
  };
  // Prisma can't narrow a generic select-or-include, so the row is typed back
  // to the shape the caller asked for here, once.
  const meeting = await prisma.syncMeeting.create({ data, ...shape } as Prisma.SyncMeetingCreateArgs);
  syncMeetingSoon(orgId, meeting.id);
  return { meeting: meeting as unknown as Prisma.SyncMeetingGetPayload<S> };
}

/** A refusal in words, for Cosmo to pass on. */
export function meetingRefusalMessage(r: MeetingRefusal): string {
  if (r.kind === "attendees_not_members") return ATTENDEES_NOT_MEMBERS;
  if (r.kind === "teams_on_api_key") return "A Teams meeting is made in a person's own Outlook, so it can't be made with an API key.";
  return TEAMS_REFUSED[r.reason][1];
}

/** A refusal as the REST create answers it. */
export function meetingRefusalResponse(r: MeetingRefusal): Response {
  if (r.kind === "attendees_not_members") return attendeesNotMembers();
  if (r.kind === "teams_on_api_key") return new Response("Forbidden", { status: 403 });
  const [status, error] = TEAMS_REFUSED[r.reason];
  return Response.json({ error, reason: r.reason }, { status });
}
