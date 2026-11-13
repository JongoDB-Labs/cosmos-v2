import { prisma } from "@/lib/db/client";

/**
 * Teams meetings for Cosmos meetings pushed to Outlook: the meeting's join
 * link as Microsoft returned it for the host's event. Kept apart from the
 * sync so the connection code (which the sync imports) can clear it too.
 *
 * The link is Microsoft's answer, not an edit to the meeting: it is written
 * without touching `updated_at`, which decides who wins a conflict with an
 * Outlook edit and whether a copy someone deleted in Outlook comes back.
 */

/** What a Graph event write asks for to become a Teams meeting. */
export const TEAMS_FIELDS = { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } as const;

/** Teams is on, Microsoft made the host's event, but no Teams meeting (or refused the Teams fields). */
export const NO_JOIN_URL = "no_join_url";

const MAX_URL = 2048;

/** A join link as Microsoft returned it, or null unless it is a plain https URL of sane length. */
export function joinUrlFrom(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Keep what the host's Outlook write returned: its join link, or that there
 * is none. Only while `hostId` still hosts it, so a slow write by a former
 * host never lands. Returns whether anything changed.
 */
export async function recordTeamsLink(orgId: string, meetingId: string, hostId: string, joinUrl: string | null): Promise<boolean> {
  const issue = joinUrl ? null : NO_JOIN_URL;
  const n = await prisma.$executeRaw`
    UPDATE sync_meetings
       SET teams_join_url = ${joinUrl}, teams_issue = ${issue}
     WHERE id = ${meetingId}::uuid AND org_id = ${orgId}::uuid AND teams_host_id = ${hostId}::uuid
       AND (teams_join_url IS DISTINCT FROM ${joinUrl} OR teams_issue IS DISTINCT FROM ${issue})`;
  return n > 0;
}

/**
 * The host's event is gone (deleted, cancelled, or its calendar or account
 * went), and its Teams meeting with it: forget the link. Teams stays on; the
 * next write of their copy makes a new one. All their meetings, or just these.
 */
export async function forgetTeamsLinks(orgId: string, hostId: string, meetingIds?: string[]): Promise<number> {
  if (meetingIds && !meetingIds.length) return 0;
  return meetingIds
    ? prisma.$executeRaw`
        UPDATE sync_meetings SET teams_join_url = NULL, teams_issue = NULL
         WHERE org_id = ${orgId}::uuid AND teams_host_id = ${hostId}::uuid AND id = ANY(${meetingIds}::uuid[])
           AND (teams_join_url IS NOT NULL OR teams_issue IS NOT NULL)`
    : prisma.$executeRaw`
        UPDATE sync_meetings SET teams_join_url = NULL, teams_issue = NULL
         WHERE org_id = ${orgId}::uuid AND teams_host_id = ${hostId}::uuid
           AND (teams_join_url IS NOT NULL OR teams_issue IS NOT NULL)`;
}

/** Teams off: no host, no link. Written with Prisma, so the meeting counts as changed. */
export const TEAMS_OFF = { teamsHostId: null, teamsJoinUrl: null, teamsIssue: null } as const;

/** Why Teams ended for a meeting, as its activity records it. */
export type TeamsEndReason = "turned_off" | "classified" | "host_lost_access" | "host_disconnected" | "integration_disabled";
