import type { ToolDefinition } from "../tools";

/**
 * Google Workspace tool catalog for the AI chat. All tools require the
 * calling user to have a Google refresh token on file (see
 * `src/lib/integrations/google.ts`). Each tool's executor lives in
 * `src/lib/ai/executors/google.ts` — dispatched from
 * `src/lib/ai/tool-executor.ts`.
 *
 * Shape & arg names ported from /home/defcon/okr-dashboard/server/index.js
 * (the Gmail/Calendar/Drive/Contacts tools block around line 4520+) to keep
 * cross-product behaviour familiar, adapted to cosmos's JSON-schema
 * `input_schema` convention used by `cosmosTools`.
 */
export const googleTools: ToolDefinition[] = [
  // ── Gmail ──────────────────────────────────────────────────────────────
  {
    name: "send_email",
    description:
      "Send an email via the current user's Gmail mailbox. Supports plain text body, CC/BCC, and threaded replies. The user's Gmail signature is appended automatically when available.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Recipient email address(es), comma-separated for multiple",
        },
        subject: { type: "string", description: "Email subject line" },
        body: {
          type: "string",
          description: "Email body (plain text; newlines become <br>)",
        },
        cc: {
          type: "string",
          description: "CC email address(es), comma-separated",
        },
        bcc: {
          type: "string",
          description: "BCC email address(es), comma-separated",
        },
        replyToMessageId: {
          type: "string",
          description:
            "Gmail message ID to reply to (from search_emails results). If set, sends as a reply in that thread.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "search_emails",
    description:
      "Search the current user's Gmail inbox. Returns matching messages with id, subject, from, to, date, and snippet. Use Gmail search syntax (e.g. 'from:alice@example.com newer_than:7d', 'is:unread subject:invoice').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query — e.g. 'from:steve@example.com', 'subject:invoice', 'is:unread newer_than:7d'",
        },
        maxResults: {
          type: "integer",
          description: "Max results to return (default 10, max 25)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_email",
    description:
      "Get the full body of a Gmail message by ID. Use after search_emails to read a specific thread.",
    input_schema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "Gmail message ID (from search_emails results)",
        },
      },
      required: ["messageId"],
    },
  },

  // ── Google Calendar ────────────────────────────────────────────────────
  {
    name: "list_calendar_events",
    description:
      "List upcoming events on the user's primary Google Calendar within a date range.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: {
          type: "string",
          description: "Start of range (ISO 8601). Defaults to now.",
        },
        timeMax: {
          type: "string",
          description:
            "End of range (ISO 8601). Defaults to 14 days from now.",
        },
        maxResults: {
          type: "integer",
          description: "Max events to return (default 25, max 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a Google Calendar event on the user's primary calendar. Automatically attaches a Google Meet link. Sends invites to attendees when provided.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        description: { type: "string", description: "Event description" },
        location: { type: "string", description: "Event location" },
        start: {
          type: "string",
          description:
            "Start: YYYY-MM-DD for all-day, or ISO datetime (YYYY-MM-DDTHH:MM[:SS]) for timed",
        },
        end: {
          type: "string",
          description: "End: same format as start",
        },
        allDay: {
          type: "boolean",
          description: "True for all-day events",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses",
        },
        timeZone: {
          type: "string",
          description: "IANA timezone (default America/New_York)",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "update_calendar_event",
    description:
      "Update an existing Google Calendar event. Only the fields you pass are changed.",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Google Calendar event ID" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        allDay: { type: "boolean" },
        attendees: { type: "array", items: { type: "string" } },
        timeZone: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Delete a Google Calendar event by ID.",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Google Calendar event ID" },
      },
      required: ["eventId"],
    },
  },

  // ── Google Drive ───────────────────────────────────────────────────────
  {
    name: "list_drive_files",
    description:
      "List files in the user's Google Drive. Optional search query filters by name. Returns id, name, mimeType, modifiedTime, webViewLink.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Filter files whose name contains this string",
        },
        folderId: {
          type: "string",
          description:
            "Restrict listing to this Drive folder ID. Omit for the root of My Drive.",
        },
        maxResults: {
          type: "integer",
          description: "Max files to return (default 25, max 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "read_google_doc",
    description:
      "Extract the full text content of a Google Doc by file ID (find IDs via list_drive_files). Returns the document title and up to ~10k chars of text.",
    input_schema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "Google Drive file ID of the document",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "create_drive_folder",
    description:
      "Create a new folder in the user's Google Drive. Optionally nest under a parent folder.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name" },
        parentFolderId: {
          type: "string",
          description: "Parent folder ID. Omit for the root of My Drive.",
        },
      },
      required: ["name"],
    },
  },

  // ── Google Contacts (People API) ───────────────────────────────────────
  {
    name: "search_contacts",
    description:
      "Search the user's Google Contacts by name, email, or company. Searches both saved contacts AND 'other contacts' (auto-populated from email history). Use to look up addresses before sending emails or adding calendar attendees.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — name, email, or company name",
        },
      },
      required: ["query"],
    },
  },
];
