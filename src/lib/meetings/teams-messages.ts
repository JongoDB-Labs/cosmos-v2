/**
 * Teams meetings for Cosmos meetings (made through Outlook): why one can't be
 * turned on or off, and what that status means, in the words people see.
 * Pure: the API answers with these and the meeting screens show them.
 */

/** Why someone can't turn a meeting's Teams meeting on (or off). */
export type TeamsRefusal =
  | "not_found" | "rate_limited" | "not_available" | "cancelled" | "classified" | "cannot_edit"
  | "invites_by_someone_else" | "not_connected" | "reconnect" | "invite_sent";

/** The HTTP status and message for each refusal. */
export const TEAMS_REFUSED: Record<TeamsRefusal, [number, string]> = {
  not_found: [404, "Not found"],
  rate_limited: [429, "You've changed Teams meetings too often. Try again later."],
  not_available: [409, "Teams meetings need Outlook Calendar, which isn't turned on for this organization."],
  cancelled: [409, "This meeting is cancelled."],
  classified: [409, "Classified meetings can't be Teams meetings."],
  cannot_edit: [403, "Only someone who can edit this meeting can change its Teams meeting."],
  invites_by_someone_else: [409, "Outlook invitations for this meeting come from someone else. Only they can add a Teams meeting."],
  not_connected: [409, "Connect your Outlook Calendar first (Settings, Preferences). The Teams meeting is made in your Outlook."],
  reconnect: [409, "Reconnect your Outlook Calendar first (Settings, Preferences)."],
  invite_sent: [409, "The Outlook invitation already went out with this Teams meeting. Turn off Outlook invitations first."],
};

/** What a Teams meeting's status means, while it's on. */
export const TEAMS_STATUS: Record<"pending" | "no_join_url" | "host_not_connected" | "host_reconnect", string> = {
  pending: "No join link yet. It appears once the meeting is in the host's Outlook.",
  no_join_url:
    "Microsoft made the Outlook event but no Teams meeting, so there is no join link. The host's account may not have Teams. Cosmos tries again when the meeting changes.",
  host_not_connected: "No join link: the host's Outlook Calendar isn't connected.",
  host_reconnect: "No join link yet: the host needs to reconnect Outlook Calendar (Settings, Preferences).",
};

/**
 * Why Outlook invitations can't go on while someone else hosts the meeting's
 * Teams meeting: the invitation would have to hold it, which would end theirs.
 */
export function teamsHostedMessage(hostName: string | null): string {
  return `${hostName ?? "Someone else"} hosts this meeting's Teams link. Ask them to turn on invitations, or turn Teams off first.`;
}
