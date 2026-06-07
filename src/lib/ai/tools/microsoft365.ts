import type { ToolDefinition } from "../tools";

/**
 * Microsoft 365 (Microsoft Graph) tool catalog for the AI assistant — READ-only.
 *
 * These tools require the ORG to have connected Microsoft 365 via the integrations page
 * (an Entra app registration: client ID + client secret + tenant ID; the secret — and
 * the rest of the app identity — are sealed into the org-level vault credential, see
 * `src/lib/integrations/credentials.ts` getOrgCredential + the sealed-install secret
 * split). The credential is org-SHARED, NOT per-user. Authentication uses the OAuth2
 * **client-credentials** (app-only) grant via `src/lib/integrations/microsoft-graph.ts`
 * (cloud-correct authority/scope/base, token cached). Each tool's executor lives in
 * `src/lib/ai/executors/microsoft365.ts` — dispatched from `tool-executor.ts` via the
 * connector registry.
 *
 * Because the grant is APP-ONLY (no signed-in user), every mailbox/calendar/drive read
 * targets an explicit `userId` (an Entra object id or userPrincipalName). `m365_list_users`
 * supplies those ids.
 *
 * Results flow through the egress chokepoint: gov tenants see STRUCTURAL fields only
 * (message/event/file/user ids + flags + timestamps + sizes), never the subject, body,
 * sender/recipients, file names, or any display name / email (PII / content).
 */
export const microsoft365Tools: ToolDefinition[] = [
  {
    name: "m365_list_users",
    description:
      "List Microsoft 365 (Entra/Azure AD) users in the connected org directory (read-only). Returns each user's id and accountEnabled flag. Use a returned user id with the other m365_* tools. (displayName / mail / userPrincipalName are fetched but withheld from the model for gov tenants by the egress gate.)",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max users to return (default 20, max 50).",
        },
      },
      required: [],
    },
  },
  {
    name: "m365_list_messages",
    description:
      "List a user's Microsoft 365 mailbox messages (read-only). Requires the user's id (from m365_list_users). Returns each message's id, receivedDateTime, isRead, hasAttachments, and importance. (subject / body / from / recipients are fetched but withheld from the model for gov tenants by the egress gate.)",
    input_schema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description:
            "The user's id or userPrincipalName whose mailbox to read (from m365_list_users).",
        },
        limit: {
          type: "integer",
          description: "Max messages to return (default 20, max 50).",
        },
      },
      required: ["userId"],
    },
  },
  {
    name: "m365_list_events",
    description:
      "List a user's Microsoft 365 calendar events (read-only). Requires the user's id (from m365_list_users). Returns each event's id, start, end, isAllDay, isCancelled, and showAs. (subject / body / location / organizer / attendees are fetched but withheld from the model for gov tenants by the egress gate.)",
    input_schema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description:
            "The user's id or userPrincipalName whose calendar to read (from m365_list_users).",
        },
        limit: {
          type: "integer",
          description: "Max events to return (default 20, max 50).",
        },
      },
      required: ["userId"],
    },
  },
  {
    name: "m365_list_drive_items",
    description:
      "List items in the root of a user's Microsoft 365 OneDrive (read-only). Requires the user's id (from m365_list_users). Returns each item's id, size, createdDateTime, lastModifiedDateTime, and isFolder. (name / webUrl / createdBy / lastModifiedBy are fetched but withheld from the model for gov tenants by the egress gate.)",
    input_schema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description:
            "The user's id or userPrincipalName whose OneDrive to read (from m365_list_users).",
        },
        limit: {
          type: "integer",
          description: "Max drive items to return (default 20, max 50).",
        },
      },
      required: ["userId"],
    },
  },
];
