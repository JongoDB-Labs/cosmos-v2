import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, NullableUuid, Uuid } from "@/lib/openapi/schemas/common";

const InviteState = z.object({
  available: z.boolean().describe("Whether the org has Outlook Calendar on."),
  on: z.boolean(),
  organizerId: NullableUuid,
  canChange: z.boolean(),
  reason: z.enum(["classified", "not_connected", "reconnect", "cannot_edit", "too_many_attendees", "cancelled"]).nullable(),
  recipients: z.array(z.object({ name: z.string(), email: z.string(), outside: z.boolean() })),
  domains: z.array(z.string()),
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
    "connected, over 100 attendees, or over 10 changes an hour. Not for API keys.",
  tags: ["Meetings"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, meetingId: Uuid }), body: z.object({ enabled: z.boolean() }) },
  responses: { 200: InviteState },
  errors: [400, 401, 403, 404, 409, 429],
});
