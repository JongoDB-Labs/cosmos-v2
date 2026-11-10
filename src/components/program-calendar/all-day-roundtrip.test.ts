// @vitest-environment node
//
// The all-day end date survives a round trip.
//
// Three representations, and the conversions between them are asymmetric,
// which is exactly where this rots:
//   - the FORM shows an INCLUSIVE end date ("30 Nov - 4 Dec" is five days)
//   - the API/service stores a HALF-OPEN range (ends 5 Dec, exclusive)
//   - the form reopens by subtracting a day again
// Drop either adjustment and a five-day exercise becomes four or six, and
// nothing else in the system notices.
import { describe, it, expect } from "vitest";
import { draftToBody } from "./program-calendar";
import { normalizeRange, allDayParts, DAY_MS } from "@/lib/program-calendar/time";
import type { EventDraft } from "./event-dialog";

const base: EventDraft = {
  title: "Multi-day field event",
  categoryId: "cat",
  startDate: "2026-11-30",
  endDate: "2026-12-04",
  startTime: "09:00",
  endTime: "10:00",
  allDay: true,
  timeZone: "America/New_York",
  location: "",
  ownerKey: "",
  attendees: "",
  recurrence: "NONE",
  deliverableId: "",
  customerAttending: false,
  description: "",
  showOnDashboard: false,
};

/** What the form does when it reopens a stored event. */
const reopenEndDate = (endsAt: Date) => new Date(endsAt.getTime() - DAY_MS).toISOString().slice(0, 10);

describe("an all-day range keeps its length through the round trip", () => {
  it("stores a five-day event as five days", () => {
    const body = draftToBody(base);
    const stored = normalizeRange({
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      allDay: true,
    });
    expect(allDayParts(stored.startsAt, stored.endsAt)).toHaveLength(5);
  });

  it("reopens showing the same dates the user typed", () => {
    const body = draftToBody(base);
    const stored = normalizeRange({
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      allDay: true,
    });
    expect(stored.startsAt.toISOString().slice(0, 10)).toBe(base.startDate);
    expect(reopenEndDate(stored.endsAt)).toBe(base.endDate);
  });

  it("survives being saved and reopened twice without drifting", () => {
    // The drift bug only shows on the SECOND trip: one missing adjustment
    // moves the date by a day each time it is opened and saved.
    let draft = { ...base };
    for (let i = 0; i < 2; i++) {
      const body = draftToBody(draft);
      const stored = normalizeRange({
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        allDay: true,
      });
      draft = {
        ...draft,
        startDate: stored.startsAt.toISOString().slice(0, 10),
        endDate: reopenEndDate(stored.endsAt),
      };
    }
    expect(draft.startDate).toBe("2026-11-30");
    expect(draft.endDate).toBe("2026-12-04");
  });

  it("keeps a single-day event one day long", () => {
    const body = draftToBody({ ...base, endDate: base.startDate });
    const stored = normalizeRange({
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      allDay: true,
    });
    expect(allDayParts(stored.startsAt, stored.endsAt)).toHaveLength(1);
    expect(reopenEndDate(stored.endsAt)).toBe(base.startDate);
  });

  it("sends all-day bounds as UTC midnight, never through the local zone", () => {
    // `new Date("2026-11-30T00:00:00")` without the Z is parsed as LOCAL time,
    // and its toISOString() is then the 29th for anyone west of UTC. The
    // all-day branch must not take that path.
    const body = draftToBody(base);
    expect(body.startsAt).toBe("2026-11-30T00:00:00.000Z");
    expect(body.endsAt).toBe("2026-12-04T00:00:00.000Z");
  });
});
