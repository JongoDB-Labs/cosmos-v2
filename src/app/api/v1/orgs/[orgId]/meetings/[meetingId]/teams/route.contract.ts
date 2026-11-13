import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { NullableUuid, Uuid } from "@/lib/openapi/schemas/common";

const Refusal = z.enum([
  "not_found", "rate_limited", "not_available", "cancelled", "classified", "cannot_edit",
  "invites_by_someone_else", "not_connected", "reconnect", "invite_sent",
]);

const TeamsState = z.object({
  available: z.boolean().describe("Whether the org has Outlook Calendar on (Teams meetings are made through it)."),
  on: z.boolean().describe("The meeting is a Teams meeting."),
  hostId: NullableUuid.describe("Whose Outlook holds the Teams meeting."),
  hostName: z.string().nullable().describe("The host's display name, or email when they have none."),
  isHost: z.boolean(),
  joinUrl: z.string().nullable().describe("The Teams join link, once Microsoft has given one."),
  status: z
    .enum(["ready", "pending", "no_join_url", "host_not_connected", "host_reconnect"])
    .nullable()
    .describe(
      "While on: ready (there is a link), pending (not in the host's Outlook yet), no_join_url (Microsoft made the " +
        "event but no Teams meeting), or the host's Outlook can't be reached. Null while off.",
    ),
  canChange: z.boolean().describe("The caller may turn it on (or off) now."),
  reason: Refusal.nullable().describe("Why not, when they may not."),
});

export const getMeetingTeams = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/meetings/{meetingId}/teams",
  operationId: "getMeetingTeams",
  summary: "A meeting's Teams meeting",
  description:
    "As the signed-in person: whether the meeting is a Teams meeting, its join link, whose Outlook holds it, and " +
    "whether they may turn it on or off. Not for API keys.",
  tags: ["Meetings"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, meetingId: Uuid }) },
  responses: { 200: TeamsState },
  errors: [401, 403, 404],
});

export const setMeetingTeams = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/meetings/{meetingId}/teams",
  operationId: "setMeetingTeams",
  summary: "Turn a meeting's Teams meeting on or off",
  description:
    "On: the caller's own Outlook copy of the meeting (or, with Outlook invitations on, the organizer's invitation) " +
    "becomes a Teams meeting, and its join link is kept on the meeting. Off: that event is replaced by a plain one, " +
    "which ends the Teams meeting. Refused for classified or cancelled meetings, without edit rights, when not " +
    "connected, once an invitation went out with it (off), or over 10 changes an hour. Not for API keys.",
  tags: ["Meetings"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, meetingId: Uuid }), body: z.object({ enabled: z.boolean() }) },
  responses: { 200: TeamsState },
  errors: [400, 401, 403, 404, 409, 429],
});
