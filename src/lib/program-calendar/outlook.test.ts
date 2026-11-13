// @vitest-environment node
//
// One Graph event as the Outlook overlay draws it: pure, no database. What a
// mailbox holds must never ride along to the browser, and an all-day event
// must land on the dates its owner sees in Outlook.
import { describe, expect, it } from "vitest";
import { toOverlayEvent } from "./outlook.server";

type RawEvent = Parameters<typeof toOverlayEvent>[0];
const at = (dateTime: string) => ({ dateTime, timeZone: "UTC" });
const DRAWN = ["allDay", "end", "id", "start", "subject", "webLink"];

describe("only the fields the overlay draws leave the server", () => {
  // More than `$select` asks for: what a full Graph event carries.
  const raw = {
    id: "ev-1",
    subject: "Program review",
    start: at("2027-03-08T09:00:00.0000000"),
    end: at("2027-03-08T10:00:00.0000000"),
    isAllDay: false,
    isCancelled: false,
    webLink: "https://outlook.example/item/1",
    body: { contentType: "html", content: "<p>Agenda: budget figures</p>" },
    attendees: [{ type: "required", emailAddress: { name: "A colleague", address: "colleague@example.test" } }],
    organizer: { emailAddress: { name: "A colleague", address: "colleague@example.test" } },
    location: { displayName: "Room 4" },
  };

  it("a timed event is exactly its six drawn fields", () => {
    const e = toOverlayEvent(raw as RawEvent);
    expect(e).toEqual({
      id: "ev-1",
      subject: "Program review",
      start: "2027-03-08T09:00:00.000Z",
      end: "2027-03-08T10:00:00.000Z",
      allDay: false,
      webLink: "https://outlook.example/item/1",
    });
    expect(Object.keys(e!).sort()).toEqual(DRAWN);
  });

  it("so is an all-day one", () => {
    const e = toOverlayEvent({ ...raw, isAllDay: true, start: at("2027-03-08T00:00:00.0000000"), end: at("2027-03-09T00:00:00.0000000") } as RawEvent);
    expect(Object.keys(e!).sort()).toEqual(DRAWN);
    expect(JSON.stringify(e)).not.toMatch(/Agenda|colleague|Room 4/);
  });
});

describe("an all-day event keeps the dates Graph wrote", () => {
  const allDay = (start: string, end: string) =>
    toOverlayEvent({ id: "a", subject: "Offsite", isAllDay: true, start: at(start), end: at(end) });

  it("plain midnights, as Graph writes them, are those dates", () => {
    expect(allDay("2027-03-10T00:00:00.0000000", "2027-03-12T00:00:00.0000000")).toMatchObject({
      start: "2027-03-10T00:00:00.000Z", end: "2027-03-12T00:00:00.000Z", allDay: true,
    });
  });

  it("a midnight at +13 or +14 stays on its own date, not the day before", () => {
    expect(allDay("2026-12-25T00:00:00+13:00", "2026-12-26T00:00:00+13:00")).toMatchObject({
      start: "2026-12-25T00:00:00.000Z", end: "2026-12-26T00:00:00.000Z",
    });
    expect(allDay("2026-12-25T00:00:00+14:00", "2026-12-26T00:00:00+14:00")).toMatchObject({
      start: "2026-12-25T00:00:00.000Z", end: "2026-12-26T00:00:00.000Z",
    });
  });

  it("a midnight west of UTC stays on its date too", () => {
    expect(allDay("2027-03-10T00:00:00-05:00", "2027-03-11T00:00:00-05:00")).toMatchObject({
      start: "2027-03-10T00:00:00.000Z", end: "2027-03-11T00:00:00.000Z",
    });
  });

  it("a clock time on an all-day boundary is not rounded to another date", () => {
    // 13:00 is nearer the next midnight; the date is still the one written.
    expect(allDay("2027-03-10T13:00:00.0000000", "2027-03-11T13:00:00.0000000")).toMatchObject({
      start: "2027-03-10T00:00:00.000Z", end: "2027-03-11T00:00:00.000Z",
    });
    expect(allDay("2027-03-10T05:00:00.0000000", "2027-03-11T05:00:00.0000000")).toMatchObject({
      start: "2027-03-10T00:00:00.000Z", end: "2027-03-11T00:00:00.000Z",
    });
  });

  it("an end on or before the start still covers the start's own day", () => {
    expect(allDay("2027-03-10T00:00:00.0000000", "2027-03-10T00:00:00.0000000")).toMatchObject({
      start: "2027-03-10T00:00:00.000Z", end: "2027-03-11T00:00:00.000Z",
    });
  });

  it("control: a timed event with an offset is still converted to UTC", () => {
    const e = toOverlayEvent({ id: "t", subject: "x", start: at("2026-12-25T09:00:00+13:00"), end: at("2026-12-25T10:00:00+13:00") });
    expect(e).toMatchObject({ start: "2026-12-24T20:00:00.000Z", end: "2026-12-24T21:00:00.000Z", allDay: false });
  });
});

describe("one Graph event as the overlay draws it", () => {
  it("an empty subject reads as having no title; an unreadable time is left off", () => {
    expect(toOverlayEvent({ id: "b", subject: "  ", start: at("2027-03-10T09:00:00"), end: at("2027-03-10T10:00:00") })?.subject).toBe("(No title)");
    expect(toOverlayEvent({ id: "c", subject: "x", start: at("not a time"), end: at("2027-03-10T10:00:00") })).toBeNull();
    expect(toOverlayEvent({ id: "c2", subject: "x", isAllDay: true, start: at("not a date"), end: at("2027-03-11T00:00:00") })).toBeNull();
  });

  it("a time with an explicit offset is honoured", () => {
    const e = toOverlayEvent({ id: "d", subject: "x", start: at("2027-03-10T09:00:00-05:00"), end: at("2027-03-10T10:00:00-05:00") });
    expect(e?.start).toBe("2027-03-10T14:00:00.000Z");
  });

  it("a cancelled meeting is not drawn; control: the same meeting, not cancelled, is", () => {
    const m = { id: "e", subject: "x", start: at("2027-03-10T09:00:00"), end: at("2027-03-10T10:00:00") };
    expect(toOverlayEvent({ ...m, isCancelled: true })).toBeNull();
    expect(toOverlayEvent(m)).not.toBeNull();
  });
});
