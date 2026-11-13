import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, NullableUuid, Uuid } from "@/lib/openapi/schemas/common";

const InviteState = z.object({
  available: z.boolean().describe("Whether the org has Outlook Calendar on."),
  on: z.boolean(),
  organizerId: NullableUuid,
  organizerName: z.string().nullable().describe("The organizer's display name, or email when they have none."),
  canChange: z.boolean(),
  reason: z
    .enum(["classified", "not_connected", "reconnect", "cannot_edit", "too_many_attendees", "cancelled", "teams_hosted_by_someone_else"])
    .nullable(),
  teamsHostId: NullableUuid.describe("Who hosts the meeting's Teams meeting. Invitations can't go on while it is someone else."),
  teamsHostName: z.string().nullable().describe("The Teams host's display name, or email when they have none."),
  recipients: z.array(z.object({ name: z.string(), email: z.string(), outside: z.boolean() })),
  domains: z.array(z.string()),
  pendingCancel: z.boolean().describe("The invitation's cancellation is waiting for the organizer to reconnect Outlook."),
  sent: z
    .boolean()
    .nullable()
    .describe(
      "Outlook accepted the organizer's event with the attendees on it. False while `on` means nobody has been invited yet: Outlook refused it or the organizer must reconnect; every sync retries. Null once the meeting has been over a day.",
    ),
  isOrganizer: z.boolean().describe("The signed-in person is the organizer, whose Outlook sends the invitations."),
  ended: z.object({ how: z.enum(["released", "cancelled"]), reason: z.string().nullable(), at: IsoDateTime }).nullable(),
});

export const getMeetingOutlookInvite = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/meetings/{meetingId}/outlook-invite",
  operationId: "getMeetingOutlookInvite",
  summary: "A meeting's Outlook invitations",
  description:
    "COSMOS-202 invite mode, as the signed-in person: whether the meeting's Outlook invitations are on and who " +
    "sends them, and what turning them on would do (who'd be invited, who is outside the org's domains). Not for API keys.",
  tags: ["Meetings"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, meetingId: Uuid }) },
  responses: { 200: InviteState.extend({ organizerName: z.string().nullable() }) },
  errors: [401, 403, 404],
});

export const setMeetingOutlookInvite = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/meetings/{meetingId}/outlook-invite",
  operationId: "setMeetingOutlookInvite",
  summary: "Turn a meeting's Outlook invitations on or off",
  description:
    "On: invitations go out from the caller's own Outlook calendar (they become the organizer). Off: attendees get a " +
    "cancellation and their mirrored copies come back. Refused for classified meetings, without edit rights, when not " +
    "connected, over 100 attendees, while someone else hosts its Teams meeting, or over 10 changes an hour. Not for API keys.",
  tags: ["Meetings"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, meetingId: Uuid }), body: z.object({ enabled: z.boolean() }) },
  responses: { 200: InviteState },
  errors: [400, 401, 403, 404, 409, 429],
});
