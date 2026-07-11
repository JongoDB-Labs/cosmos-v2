// @vitest-environment node
//
// Teams meetings lib (COSMOS-48) — locks the Graph contract for the meeting
// lifecycle on the linked M365 tenant:
//   - schedule POSTs a calendar event with isOnlineMeeting + teamsForBusiness;
//   - list reads online events only and normalizes them (join URL, attendees);
//   - invite/remove PATCHes the FULL attendee set; cancel/delete hit the right verbs;
//   - every op threads the caller's orgId (tenant scoping) and passes lib errors
//     (not-connected / Graph 403) straight through as graceful { ok:false } results;
//   - required-field validation short-circuits BEFORE any Graph call.
// graphFetch/graphWrite are mocked so no token/network is involved.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { graphFetch, graphWrite } = vi.hoisted(() => ({
  graphFetch: vi.fn(),
  graphWrite: vi.fn(),
}));
vi.mock("./microsoft-graph", () => ({ graphFetch, graphWrite }));

import {
  scheduleTeamsMeeting,
  listTeamsMeetings,
  updateTeamsMeetingAttendees,
  cancelTeamsMeeting,
  deleteTeamsMeeting,
} from "./teams-meetings";

const ORG = "org-1";

/** A representative Graph event payload (as /events would return it). */
function graphEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    subject: "Sprint sync",
    start: { dateTime: "2026-07-15T10:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-07-15T10:30:00", timeZone: "UTC" },
    webLink: "https://outlook.office365.com/evt-1",
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz" },
    isOnlineMeeting: true,
    isCancelled: false,
    attendees: [
      {
        type: "required",
        emailAddress: { address: "a@x.com", name: "Ada" },
        status: { response: "accepted" },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleTeamsMeeting", () => {
  const good = {
    organizer: "u1",
    subject: "Sprint sync",
    start: "2026-07-15T10:00:00",
    end: "2026-07-15T10:30:00",
    attendees: [{ email: "a@x.com", name: "Ada" }],
  };

  it("POSTs an online calendar event and returns the mapped meeting", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: graphEvent() });
    const res = await scheduleTeamsMeeting(ORG, good);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [orgId, method, path, body] = graphWrite.mock.calls[0];
    expect(orgId).toBe(ORG); // tenant scoping — the caller's org
    expect(method).toBe("POST");
    expect(path).toBe("/users/u1/events");
    expect(body.isOnlineMeeting).toBe(true);
    expect(body.onlineMeetingProvider).toBe("teamsForBusiness");
    expect(body.start).toEqual({ dateTime: "2026-07-15T10:00:00", timeZone: "UTC" });
    expect(body.attendees).toEqual([
      { emailAddress: { address: "a@x.com", name: "Ada" }, type: "required" },
    ]);

    expect(res.meeting.id).toBe("evt-1");
    expect(res.meeting.joinUrl).toBe("https://teams.microsoft.com/l/meetup-join/xyz");
    expect(res.meeting.attendees[0]).toEqual({
      email: "a@x.com",
      name: "Ada",
      type: "required",
      response: "accepted",
    });
  });

  it("honors an explicit timeZone and HTML body", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: graphEvent() });
    await scheduleTeamsMeeting(ORG, {
      ...good,
      timeZone: "America/New_York",
      bodyHtml: "<p>agenda</p>",
    });
    const [, , , body] = graphWrite.mock.calls[0];
    expect(body.start.timeZone).toBe("America/New_York");
    expect(body.body).toEqual({ contentType: "HTML", content: "<p>agenda</p>" });
  });

  it("url-encodes a UPN organizer", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: graphEvent() });
    await scheduleTeamsMeeting(ORG, { ...good, organizer: "boss@contoso.com" });
    expect(graphWrite.mock.calls[0][2]).toBe("/users/boss%40contoso.com/events");
  });

  it.each([
    ["missing organizer", { ...good, organizer: "  " }, /organizer/i],
    ["missing subject", { ...good, subject: "" }, /subject/i],
    ["unparseable date", { ...good, start: "not-a-date" }, /valid date/i],
    ["end before start", { ...good, end: "2026-07-15T09:00:00" }, /after the start/i],
  ])("validates: %s (no Graph call)", async (_label, input, re) => {
    const res = await scheduleTeamsMeeting(ORG, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(re);
    expect(graphWrite).not.toHaveBeenCalled();
  });

  it("passes a not-connected error straight through", async () => {
    graphWrite.mockResolvedValue({ ok: false, error: "Microsoft 365 is not connected for this organization." });
    const res = await scheduleTeamsMeeting(ORG, good);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not connected/i);
  });
});

describe("listTeamsMeetings", () => {
  it("reads online events only, normalizes and sorts newest-first", async () => {
    graphFetch.mockResolvedValue({
      ok: true,
      data: {
        value: [
          graphEvent({ id: "old", start: { dateTime: "2026-07-10T10:00:00", timeZone: "UTC" } }),
          graphEvent({ id: "new", start: { dateTime: "2026-07-20T10:00:00", timeZone: "UTC" } }),
          graphEvent({ id: "not-online", isOnlineMeeting: false }),
        ],
      },
    });
    const res = await listTeamsMeetings(ORG, { organizer: "u1", top: 25 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meetings.map((m) => m.id)).toEqual(["new", "old"]); // filtered + sorted
    const [orgId, path] = graphFetch.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(path).toContain("/users/u1/events");
    expect(path).toContain("$select=");
    expect(path).toContain("$top=25");
  });

  it("requires an organizer", async () => {
    const res = await listTeamsMeetings(ORG, { organizer: "" });
    expect(res.ok).toBe(false);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("passes a Graph error through", async () => {
    graphFetch.mockResolvedValue({ ok: false, error: "Microsoft Graph API error (HTTP 403): ErrorAccessDenied" });
    const res = await listTeamsMeetings(ORG, { organizer: "u1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("403");
  });
});

describe("updateTeamsMeetingAttendees (invite / remove)", () => {
  it("PATCHes the FULL desired attendee set", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: graphEvent() });
    const res = await updateTeamsMeetingAttendees(ORG, {
      organizer: "u1",
      eventId: "evt-1",
      attendees: [
        { email: "keep@x.com" },
        { email: "new@x.com", type: "optional" },
      ],
    });
    expect(res.ok).toBe(true);
    const [orgId, method, path, body] = graphWrite.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(method).toBe("PATCH");
    expect(path).toBe("/users/u1/events/evt-1");
    expect(body.attendees).toEqual([
      { emailAddress: { address: "keep@x.com" }, type: "required" },
      { emailAddress: { address: "new@x.com" }, type: "optional" },
    ]);
  });

  it("removing everyone sends an empty attendee array", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: graphEvent({ attendees: [] }) });
    await updateTeamsMeetingAttendees(ORG, { organizer: "u1", eventId: "evt-1", attendees: [] });
    expect(graphWrite.mock.calls[0][3].attendees).toEqual([]);
  });

  it("requires organizer, eventId, and an attendees array", async () => {
    expect((await updateTeamsMeetingAttendees(ORG, { organizer: "", eventId: "e", attendees: [] })).ok).toBe(false);
    expect((await updateTeamsMeetingAttendees(ORG, { organizer: "u1", eventId: "", attendees: [] })).ok).toBe(false);
    // @ts-expect-error — exercising the runtime guard for a non-array attendees
    expect((await updateTeamsMeetingAttendees(ORG, { organizer: "u1", eventId: "e", attendees: undefined })).ok).toBe(false);
    expect(graphWrite).not.toHaveBeenCalled();
  });
});

describe("cancelTeamsMeeting", () => {
  it("POSTs the /cancel action with the comment", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: null });
    const res = await cancelTeamsMeeting(ORG, { organizer: "u1", eventId: "evt-1", comment: "postponed" });
    expect(res.ok).toBe(true);
    const [orgId, method, path, body] = graphWrite.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(method).toBe("POST");
    expect(path).toBe("/users/u1/events/evt-1/cancel");
    expect(body).toEqual({ comment: "postponed" });
  });

  it("defaults the comment to an empty string", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: null });
    await cancelTeamsMeeting(ORG, { organizer: "u1", eventId: "evt-1" });
    expect(graphWrite.mock.calls[0][3]).toEqual({ comment: "" });
  });

  it("requires organizer and eventId", async () => {
    expect((await cancelTeamsMeeting(ORG, { organizer: "", eventId: "e" })).ok).toBe(false);
    expect((await cancelTeamsMeeting(ORG, { organizer: "u1", eventId: "" })).ok).toBe(false);
    expect(graphWrite).not.toHaveBeenCalled();
  });
});

describe("deleteTeamsMeeting", () => {
  it("DELETEs the event with no body", async () => {
    graphWrite.mockResolvedValue({ ok: true, data: null });
    const res = await deleteTeamsMeeting(ORG, { organizer: "u1", eventId: "evt-1" });
    expect(res.ok).toBe(true);
    const [orgId, method, path, body] = graphWrite.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(method).toBe("DELETE");
    expect(path).toBe("/users/u1/events/evt-1");
    expect(body).toBeUndefined();
  });

  it("requires organizer and eventId", async () => {
    expect((await deleteTeamsMeeting(ORG, { organizer: "u1", eventId: "" })).ok).toBe(false);
    expect(graphWrite).not.toHaveBeenCalled();
  });

  it("passes a Graph error through", async () => {
    graphWrite.mockResolvedValue({ ok: false, error: "Microsoft Graph API error (HTTP 404): ErrorItemNotFound" });
    const res = await deleteTeamsMeeting(ORG, { organizer: "u1", eventId: "gone" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("404");
  });
});
