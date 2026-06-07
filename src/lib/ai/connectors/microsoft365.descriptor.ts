// src/lib/ai/connectors/microsoft365.descriptor.ts
//
// Microsoft 365 (Microsoft Graph — mail/calendar/files/users) expressed as a
// ConnectorDescriptor — mirrors the GitHub/Jira/Slack pattern (tools/microsoft365.ts
// defs + executors/microsoft365.ts dispatch). availability:"all" — M365 is a gov-usable
// native connector behind our own egress fence (the Entra app credential is sealed in the
// vault; the client-credentials access token is minted server-side and NEVER reaches the
// model; the model only ever sees what the gate projects). The gov tenant uses the
// GCC-High cloud (login.microsoftonline.us / graph.microsoft.us) via the per-org `cloud`
// toggle — that endpoint choice is internal to microsoft-graph.ts and does not change the
// egress fence below.
//
// EGRESS — gov sees STRUCTURAL ONLY; content/PII WITHHELD (default-deny):
//   - TOOL_ENTITY:
//       m365_list_messages    → m365_message
//       m365_list_events      → m365_event
//       m365_list_drive_items → m365_drive_item
//       m365_list_users       → m365_user
//   - EXPOSABLE_FIELDS:
//       m365_message:    id, receivedDateTime, isRead, hasAttachments, importance.
//                        WITHHOLD: subject, body, bodyPreview, from, toRecipients,
//                        ccRecipients (content / PII).
//       m365_event:      id, start, end, isAllDay, isCancelled, showAs.
//                        WITHHOLD: subject, body, location, organizer, attendees.
//       m365_drive_item: id, size, createdDateTime, lastModifiedDateTime, isFolder
//                        (a derived bool). WITHHOLD: name, webUrl, createdBy,
//                        lastModifiedBy.
//       m365_user:       id, accountEnabled. WITHHOLD: displayName, mail,
//                        userPrincipalName, jobTitle (PII).
//   - HANDLEABLE_FIELDS: NONE — M365 has no handleable CUI string field (the model
//                        orchestrates BY id under the MAC ceiling, never by referencing a
//                        subject/name/email). Omitted on purpose.
//
// A gov tenant therefore sees message/event/file/user ids + structural flags/timestamps/
// sizes and NEVER the subject/body/from/name/displayName/mail.

import type { ConnectorDescriptor } from "./types";
import { microsoft365Tools } from "../tools/microsoft365";
import { executeMicrosoft365Tool } from "../executors/microsoft365";

export const microsoft365Connector: ConnectorDescriptor = {
  provider: "microsoft365",
  availability: "all", // gov-usable (GCC-High via the per-org cloud toggle in microsoft-graph.ts)
  toolDefs: microsoft365Tools,
  execute: (name, input, ctx) =>
    executeMicrosoft365Tool(name, input, { userId: ctx.userId, orgId: ctx.orgId }),
  egress: {
    m365_list_messages: { entityType: "m365_message" },
    m365_list_events: { entityType: "m365_event" },
    m365_list_drive_items: { entityType: "m365_drive_item" },
    m365_list_users: { entityType: "m365_user" },
  },
  exposableFields: {
    // m365ListMessages returns a shallow message shape including subject/bodyPreview/from
    // (content/PII). Structural ONLY: id + the read/attachment flags + importance (enum)
    // + receivedDateTime. subject/body/from/recipients are content/PII → WITHHELD.
    m365_message: ["id", "receivedDateTime", "isRead", "hasAttachments", "importance"],
    // m365ListEvents returns id/start/end/flags + subject/location (content/PII).
    // Structural ONLY: id + start/end + the boolean flags + showAs (enum). subject/body/
    // location/organizer/attendees are content/PII → WITHHELD.
    m365_event: ["id", "start", "end", "isAllDay", "isCancelled", "showAs"],
    // m365ListDriveItems returns id/size/timestamps/isFolder + name/webUrl (content/PII).
    // Structural ONLY: id + size (number) + timestamps + isFolder (derived bool). name/
    // webUrl/createdBy/lastModifiedBy are content/PII → WITHHELD.
    m365_drive_item: ["id", "size", "createdDateTime", "lastModifiedDateTime", "isFolder"],
    // m365ListUsers returns id/accountEnabled + displayName/mail/UPN/jobTitle (PII).
    // Structural ONLY: id + accountEnabled (bool). displayName/mail/userPrincipalName/
    // jobTitle are PII → WITHHELD.
    m365_user: ["id", "accountEnabled"],
  },
  // No handleableFields: M365 has no handleable CUI string field (see header).
};
