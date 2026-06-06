/**
 * Google Workspace tool executors for the AI chat.
 *
 * Each function:
 * - Pulls the calling user's Google refresh token via the integration
 *   helpers in `src/lib/integrations/google.ts` (which wrap googleapis).
 * - Returns a plain JSON-serializable object — the chat route stringifies
 *   it back to the LLM as the tool result.
 * - On missing-token errors, returns `{ error: "..." }` instead of throwing
 *   so the model can apologise and continue. Other errors are caught here
 *   and surfaced the same way (we never expose the raw refresh token).
 *
 * Port of the Gmail/Calendar/Drive/Contacts implementations from
 * /home/defcon/okr-dashboard/server/index.js (~lines 5290–5860), adapted to
 * cosmos's per-user OAuth helpers.
 */

import { randomBytes } from "node:crypto";
import type { calendar_v3, docs_v1, drive_v3, gmail_v1, people_v1 } from "googleapis";
import {
  getCalendarClient,
  getDocsClient,
  getDriveClient,
  getGmailClient,
  getPeopleClient,
} from "@/lib/integrations/google";

interface GoogleToolContext {
  userId: string;
  /** The caller's org — scopes the sealed credential lookup + self-heal. */
  orgId: string;
}

type ToolArgs = Record<string, unknown>;

const MISSING_TOKEN_ERROR =
  "User has not connected their Google account (no refresh token on file). Ask them to sign in with Google again to grant access.";

/**
 * Wrap any executor — translate "no refresh token" thrown by
 * getGoogleClientForUser() into a graceful tool error, and stringify
 * other unexpected failures rather than letting them bubble through to
 * the chat loop.
 */
async function safeRun<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Google not connected")) {
      return { error: MISSING_TOKEN_ERROR };
    }
    return { error: msg };
  }
}

// ── Gmail ────────────────────────────────────────────────────────────────

async function fetchGmailSignature(gmail: gmail_v1.Gmail): Promise<string> {
  try {
    const sendAs = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = (sendAs.data.sendAs || []).find((s) => s.isPrimary);
    return primary?.signature || "";
  } catch {
    return "";
  }
}

export async function sendEmail(args: ToolArgs, ctx: GoogleToolContext) {
  return safeRun(async () => {
    const to = String(args.to ?? "");
    const subject = String(args.subject ?? "");
    const body = String(args.body ?? "");
    const cc = args.cc ? String(args.cc) : "";
    const bcc = args.bcc ? String(args.bcc) : "";
    const replyToMessageId = args.replyToMessageId
      ? String(args.replyToMessageId)
      : "";

    if (!to || !subject || !body) {
      return { error: "to, subject, and body are required" };
    }

    const gmail = await getGmailClient(ctx.userId, ctx.orgId);
    const signature = await fetchGmailSignature(gmail);
    const bodyHtml =
      body.replace(/\n/g, "<br>") +
      (signature ? `<br><br>--<br>${signature}` : "");

    const headers: string[] = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/html; charset=utf-8",
      "MIME-Version: 1.0",
    ];
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);

    let threadId: string | undefined;
    if (replyToMessageId) {
      try {
        const orig = await gmail.users.messages.get({
          userId: "me",
          id: replyToMessageId,
          format: "metadata",
          metadataHeaders: ["Message-ID"],
        });
        threadId = orig.data.threadId ?? undefined;
        const origMessageId = (orig.data.payload?.headers || []).find(
          (h) => h.name === "Message-ID",
        )?.value;
        if (origMessageId) {
          headers.push(`In-Reply-To: ${origMessageId}`);
          headers.push(`References: ${origMessageId}`);
        }
      } catch {
        /* proceed without threading */
      }
    }

    const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + bodyHtml)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: threadId ? { raw, threadId } : { raw },
    });

    return {
      success: true,
      messageId: response.data.id,
      threadId: response.data.threadId,
      message: `Email sent to ${to}: "${subject}"`,
    };
  });
}

export async function searchEmails(args: ToolArgs, ctx: GoogleToolContext) {
  return safeRun(async () => {
    const query = String(args.query ?? "");
    if (!query) return { error: "query is required" };
    const maxResults = Math.min(
      Math.max(Number(args.maxResults ?? 10) || 10, 1),
      25,
    );

    const gmail = await getGmailClient(ctx.userId, ctx.orgId);
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });
    const messages = list.data.messages || [];

    const results: Array<{
      id: string;
      threadId: string;
      from: string;
      to: string;
      subject: string;
      date: string;
      snippet: string;
    }> = [];

    for (const m of messages) {
      if (!m.id) continue;
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      const headers = detail.data.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value ?? "";
      results.push({
        id: m.id,
        threadId: detail.data.threadId ?? "",
        from: get("From"),
        to: get("To"),
        subject: get("Subject"),
        date: get("Date"),
        snippet: detail.data.snippet ?? "",
      });
    }

    return {
      success: true,
      count: results.length,
      emails: results,
    };
  });
}

export async function readEmail(args: ToolArgs, ctx: GoogleToolContext) {
  return safeRun(async () => {
    const messageId = String(args.messageId ?? "");
    if (!messageId) return { error: "messageId is required" };

    const gmail = await getGmailClient(ctx.userId, ctx.orgId);
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    let body = "";
    const extractText = (part: gmail_v1.Schema$MessagePart | undefined) => {
      if (!part) return;
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      (part.parts || []).forEach(extractText);
    };
    extractText(detail.data.payload || undefined);
    if (!body && detail.data.snippet) body = detail.data.snippet;

    const headers = detail.data.payload?.headers || [];
    const get = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";

    return {
      success: true,
      email: {
        id: messageId,
        threadId: detail.data.threadId,
        from: get("From"),
        to: get("To"),
        cc: get("Cc"),
        subject: get("Subject"),
        date: get("Date"),
        body: body.slice(0, 8000),
        truncated: body.length > 8000,
      },
    };
  });
}

// ── Google Calendar ──────────────────────────────────────────────────────

const DEFAULT_TZ = "America/New_York";

function buildEventBody(args: ToolArgs): calendar_v3.Schema$Event {
  const event: calendar_v3.Schema$Event = {};
  if (args.summary !== undefined) event.summary = String(args.summary);
  if (args.description !== undefined)
    event.description = String(args.description);
  if (args.location !== undefined) event.location = String(args.location);

  // Ensure HH:MM datetimes get :00 appended (Google requires seconds)
  const fixDt = (dt: string) => (dt.length === 16 ? `${dt}:00` : dt);
  const tz = args.timeZone ? String(args.timeZone) : DEFAULT_TZ;

  if (args.allDay) {
    if (args.start) event.start = { date: String(args.start) };
    if (args.end || args.start)
      event.end = { date: String(args.end ?? args.start) };
  } else {
    if (args.start)
      event.start = { dateTime: fixDt(String(args.start)), timeZone: tz };
    if (args.end)
      event.end = { dateTime: fixDt(String(args.end)), timeZone: tz };
  }

  if (Array.isArray(args.attendees) && args.attendees.length > 0) {
    event.attendees = (args.attendees as unknown[]).map((e) => ({
      email: String(e).trim(),
    }));
  }
  return event;
}

export async function listCalendarEvents(
  args: ToolArgs,
  ctx: GoogleToolContext,
) {
  return safeRun(async () => {
    const cal = await getCalendarClient(ctx.userId, ctx.orgId);
    const timeMin = args.timeMin
      ? String(args.timeMin)
      : new Date().toISOString();
    const timeMax = args.timeMax
      ? String(args.timeMax)
      : new Date(Date.now() + 14 * 86400000).toISOString();
    const maxResults = Math.min(
      Math.max(Number(args.maxResults ?? 25) || 25, 1),
      100,
    );

    const response = await cal.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults,
    });

    const events = (response.data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      location: e.location,
      attendees: (e.attendees || []).map((a) => a.email).filter(Boolean),
      hangoutLink: e.hangoutLink,
      htmlLink: e.htmlLink,
      status: e.status,
    }));
    return { success: true, count: events.length, events };
  });
}

export async function createCalendarEvent(
  args: ToolArgs,
  ctx: GoogleToolContext,
) {
  return safeRun(async () => {
    if (!args.summary || !args.start || !args.end) {
      return { error: "summary, start, and end are required" };
    }
    const cal = await getCalendarClient(ctx.userId, ctx.orgId);
    const event = buildEventBody(args);
    // Auto-create a Google Meet link; if Meet provisioning fails, retry without.
    event.conferenceData = {
      createRequest: {
        requestId: randomBytes(8).toString("hex"),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };

    const hasAttendees =
      Array.isArray(args.attendees) && args.attendees.length > 0;
    let response;
    try {
      response = await cal.events.insert({
        calendarId: "primary",
        requestBody: event,
        conferenceDataVersion: 1,
        sendUpdates: hasAttendees ? "all" : "none",
      });
    } catch {
      delete event.conferenceData;
      response = await cal.events.insert({
        calendarId: "primary",
        requestBody: event,
        sendUpdates: hasAttendees ? "all" : "none",
      });
    }

    const meetLink =
      response.data.hangoutLink ||
      response.data.conferenceData?.entryPoints?.find(
        (e) => e.entryPointType === "video",
      )?.uri ||
      "";

    return {
      success: true,
      id: response.data.id,
      htmlLink: response.data.htmlLink,
      meetLink,
      message: `Created calendar event "${String(args.summary)}"${
        meetLink ? ` — Meet: ${meetLink}` : ""
      }`,
    };
  });
}

export async function updateCalendarEvent(
  args: ToolArgs,
  ctx: GoogleToolContext,
) {
  return safeRun(async () => {
    const eventId = String(args.eventId ?? "");
    if (!eventId) return { error: "eventId is required" };

    const cal = await getCalendarClient(ctx.userId, ctx.orgId);

    // Patch semantics: fetch existing, merge only changed fields.
    const existing = await cal.events.get({
      calendarId: "primary",
      eventId,
    });
    const merged: calendar_v3.Schema$Event = {
      ...existing.data,
      ...buildEventBody(args),
    };

    const hasAttendees =
      Array.isArray(args.attendees) && args.attendees.length > 0;
    const response = await cal.events.update({
      calendarId: "primary",
      eventId,
      requestBody: merged,
      sendUpdates: hasAttendees ? "all" : "none",
    });

    return {
      success: true,
      id: response.data.id,
      htmlLink: response.data.htmlLink,
      message: `Updated calendar event "${response.data.summary ?? eventId}"`,
    };
  });
}

export async function deleteCalendarEvent(
  args: ToolArgs,
  ctx: GoogleToolContext,
) {
  return safeRun(async () => {
    const eventId = String(args.eventId ?? "");
    if (!eventId) return { error: "eventId is required" };

    const cal = await getCalendarClient(ctx.userId, ctx.orgId);
    await cal.events.delete({ calendarId: "primary", eventId });
    return { success: true, message: "Deleted calendar event" };
  });
}

// ── Google Drive ─────────────────────────────────────────────────────────

export async function listDriveFiles(args: ToolArgs, ctx: GoogleToolContext) {
  return safeRun(async () => {
    const drv = await getDriveClient(ctx.userId, ctx.orgId);
    const maxResults = Math.min(
      Math.max(Number(args.maxResults ?? 25) || 25, 1),
      100,
    );

    const qParts: string[] = ["trashed = false"];
    if (args.folderId) {
      qParts.push(`'${String(args.folderId).replace(/'/g, "\\'")}' in parents`);
    }
    if (args.query) {
      qParts.push(
        `name contains '${String(args.query).replace(/'/g, "\\'")}'`,
      );
    }

    const response = await drv.files.list({
      q: qParts.join(" and "),
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))",
      orderBy: "folder,modifiedTime desc",
      pageSize: maxResults,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = (response.data.files || []).map((f: drive_v3.Schema$File) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      owner: f.owners?.[0]?.emailAddress,
    }));

    return { success: true, count: files.length, files };
  });
}

export async function readGoogleDoc(args: ToolArgs, ctx: GoogleToolContext) {
  return safeRun(async () => {
    const fileId = String(args.fileId ?? "");
    if (!fileId) return { error: "fileId is required" };

    const docs = await getDocsClient(ctx.userId, ctx.orgId);
    const doc = await docs.documents.get({ documentId: fileId });

    let text = "";
    const extract = (content?: docs_v1.Schema$StructuralElement[]) => {
      if (!content) return;
      for (const el of content) {
        if (el.paragraph) {
          for (const pEl of el.paragraph.elements || []) {
            if (pEl.textRun?.content) text += pEl.textRun.content;
          }
        }
        if (el.table) {
          for (const row of el.table.tableRows || []) {
            for (const cell of row.tableCells || []) {
              extract(cell.content);
            }
            text += "\n";
          }
        }
      }
    };
    extract(doc.data.body?.content ?? undefined);

    return {
      success: true,
      title: doc.data.title,
      content: text.slice(0, 10000),
      truncated: text.length > 10000,
      length: text.length,
    };
  });
}

export async function createDriveFolder(
  args: ToolArgs,
  ctx: GoogleToolContext,
) {
  return safeRun(async () => {
    const name = String(args.name ?? "");
    if (!name) return { error: "name is required" };

    const drv = await getDriveClient(ctx.userId, ctx.orgId);
    const requestBody: drive_v3.Schema$File = {
      name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (args.parentFolderId) {
      requestBody.parents = [String(args.parentFolderId)];
    }

    const response = await drv.files.create({
      requestBody,
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });

    return {
      success: true,
      id: response.data.id,
      name: response.data.name,
      webViewLink: response.data.webViewLink,
      message: `Created folder "${name}"`,
    };
  });
}

// ── Google Contacts (People API) ─────────────────────────────────────────

interface ContactSummary {
  name: string;
  emails: string[];
  phones: string[];
  company: string;
}

function personToContact(p: people_v1.Schema$Person): ContactSummary {
  return {
    name: p.names?.[0]?.displayName ?? "",
    emails: (p.emailAddresses ?? [])
      .map((e) => e.value)
      .filter((v): v is string => Boolean(v)),
    phones: (p.phoneNumbers ?? [])
      .map((ph) => ph.value)
      .filter((v): v is string => Boolean(v)),
    company: p.organizations?.[0]?.name ?? "",
  };
}

export async function searchContacts(args: ToolArgs, ctx: GoogleToolContext) {
  return safeRun(async () => {
    const query = String(args.query ?? "");
    if (!query) return { error: "query is required" };

    const people = await getPeopleClient(ctx.userId, ctx.orgId);
    const results: ContactSummary[] = [];

    try {
      const resp = await people.people.searchContacts({
        query,
        readMask: "names,emailAddresses,phoneNumbers,organizations",
        pageSize: 20,
      });
      for (const r of resp.data.results || []) {
        if (r.person) results.push(personToContact(r.person));
      }
    } catch {
      /* primary search may fail silently if no contacts; we still try otherContacts */
    }

    // "Other contacts" — auto-populated from email history. May return 403
    // if the user hasn't granted the right scope; swallow.
    try {
      const resp = await people.otherContacts.search({
        query,
        readMask: "names,emailAddresses",
        pageSize: 10,
      });
      for (const r of resp.data.results || []) {
        if (!r.person) continue;
        const summary = personToContact(r.person);
        const alreadySeen = results.some((existing) =>
          summary.emails.some((e) => existing.emails.includes(e)),
        );
        if (!alreadySeen) results.push(summary);
      }
    } catch {
      /* otherContacts scope not granted — skip silently */
    }

    return { success: true, count: results.length, contacts: results };
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * Map of Google tool name → executor. Returns `null` if the name is not
 * a Google tool, so the parent dispatcher can fall through to other
 * tool families.
 */
export async function executeGoogleTool(
  name: string,
  args: ToolArgs,
  ctx: GoogleToolContext,
): Promise<unknown | null> {
  switch (name) {
    case "send_email":
      return sendEmail(args, ctx);
    case "search_emails":
      return searchEmails(args, ctx);
    case "read_email":
      return readEmail(args, ctx);
    case "list_calendar_events":
      return listCalendarEvents(args, ctx);
    case "create_calendar_event":
      return createCalendarEvent(args, ctx);
    case "update_calendar_event":
      return updateCalendarEvent(args, ctx);
    case "delete_calendar_event":
      return deleteCalendarEvent(args, ctx);
    case "list_drive_files":
      return listDriveFiles(args, ctx);
    case "read_google_doc":
      return readGoogleDoc(args, ctx);
    case "create_drive_folder":
      return createDriveFolder(args, ctx);
    case "search_contacts":
      return searchContacts(args, ctx);
    default:
      return null;
  }
}

/**
 * Names of all Google tools — exported so the central dispatcher can
 * check membership in O(1) without listing them inline.
 */
export const GOOGLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "send_email",
  "search_emails",
  "read_email",
  "list_calendar_events",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
  "list_drive_files",
  "read_google_doc",
  "create_drive_folder",
  "search_contacts",
]);
