// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  agileItems,
  daySpan,
  DEFAULT_TOGGLES,
  KIND_RANK,
  milestoneItems,
  outlookItems,
  parseToggles,
  togglesStorageKey,
  wallClock,
  type AgilePayload,
  type OutlookPayload,
} from "./overlays";

const D = (iso: string) => new Date(iso);

describe("a dated record becomes an all-day span", () => {
  it("one day runs from its UTC midnight to the next", () => {
    const s = daySpan(D("2027-01-10T00:00:00Z"), D("2027-01-10T00:00:00Z"));
    expect(s.startsAt.toISOString()).toBe("2027-01-10T00:00:00.000Z");
    expect(s.endsAt.toISOString()).toBe("2027-01-11T00:00:00.000Z");
  });

  it("the last day is inclusive: a Monday-to-Friday sprint ends at Saturday's midnight", () => {
    const s = daySpan(D("2027-01-04T00:00:00Z"), D("2027-01-08T00:00:00Z"));
    expect(s.endsAt.toISOString()).toBe("2027-01-09T00:00:00.000Z");
  });

  it("a time of day is dropped, not rounded into the next day", () => {
    const s = daySpan(D("2027-01-10T23:30:00Z"), D("2027-01-10T23:30:00Z"));
    expect(s.startsAt.toISOString()).toBe("2027-01-10T00:00:00.000Z");
    expect(s.endsAt.toISOString()).toBe("2027-01-11T00:00:00.000Z");
  });

  it("an end before its start still draws one day, never a negative bar", () => {
    const s = daySpan(D("2027-01-10T00:00:00Z"), D("2027-01-05T00:00:00Z"));
    expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(86_400_000);
  });
});

describe("Agile rows become chips", () => {
  const payload: AgilePayload = {
    intervals: [
      {
        id: "i1", name: "Sprint 4", kind: "SPRINT", startDate: "2027-01-04T00:00:00.000Z",
        endDate: "2027-01-15T00:00:00.000Z", projectKey: "WEB", projectName: "Website",
      },
      {
        id: "i2", name: "Increment 2", kind: "PROGRAM_INCREMENT", startDate: "2027-01-04T00:00:00.000Z",
        endDate: "2027-03-26T00:00:00.000Z", projectKey: "WEB", projectName: "Website",
      },
      {
        id: "i3", name: "Release 1.2", kind: "RELEASE", startDate: "2027-01-29T00:00:00.000Z",
        endDate: "2027-01-29T00:00:00.000Z", projectKey: "WEB", projectName: "Website",
      },
    ],
    due: [
      { id: "w1", key: "WEB-12", title: "Program review deck", dueDate: "2027-01-12T00:00:00.000Z", resolved: false },
      { id: "w2", key: "WEB-13", title: "Exercise A plan", dueDate: "2027-01-13T00:00:00.000Z", resolved: true },
    ],
    dueCapped: false,
  };
  const items = agileItems(payload, "acme");
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  it("each interval kind gets its own chip kind, and ids cannot collide with events", () => {
    expect(byId["sprint:i1"].kind).toBe("sprint");
    expect(byId["increment:i2"].kind).toBe("increment");
    expect(byId["release:i3"].kind).toBe("release");
    expect(byId["due:w1"].kind).toBe("due");
  });

  it("a sprint spans its days, last day included", () => {
    expect(byId["sprint:i1"].startsAt.toISOString()).toBe("2027-01-04T00:00:00.000Z");
    expect(byId["sprint:i1"].endsAt.toISOString()).toBe("2027-01-16T00:00:00.000Z");
  });

  it("links go to the record's own page, never to an editor here", () => {
    expect(byId["sprint:i1"].href).toBe("/acme/projects/WEB/intervals");
    expect(byId["due:w1"].href).toBe("/acme/work-items?item=w1");
  });

  it("a due item says its key, and says when it is done", () => {
    expect(byId["due:w1"].title).toBe("WEB-12 Program review deck");
    expect(byId["due:w1"].description).toBe("Due: WEB-12 Program review deck");
    expect(byId["due:w2"].description).toBe("Due: WEB-13 Exercise A plan (done)");
  });

  it("due dates rank below the cadence, which ranks below events", () => {
    expect(byId["due:w1"].rank).toBeGreaterThan(byId["sprint:i1"].rank);
    expect(byId["sprint:i1"].rank).toBeGreaterThan(KIND_RANK.event);
  });
});

describe("milestones become chips", () => {
  it("one day, linked to the project's milestones", () => {
    const [m] = milestoneItems(
      [{ id: "m1", title: "Program review", dueDate: "2027-02-01T00:00:00.000Z", projectKey: "WEB" }],
      "acme",
    );
    expect(m.id).toBe("milestone:m1");
    expect(m.startsAt.toISOString()).toBe("2027-02-01T00:00:00.000Z");
    expect(m.endsAt.toISOString()).toBe("2027-02-02T00:00:00.000Z");
    expect(m.href).toBe("/acme/projects/WEB/milestones");
    expect(m.rank).toBe(KIND_RANK.event);
  });
});

describe("stored toggles are read defensively", () => {
  it("nothing stored: the defaults", () => {
    expect(parseToggles(null)).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("")).toEqual(DEFAULT_TOGGLES);
  });

  it("a stored choice is honoured, key by key", () => {
    expect(parseToggles(JSON.stringify({ events: false, agile: true, outlook: true }))).toEqual({ events: false, agile: true, outlook: true });
    expect(parseToggles(JSON.stringify({ events: false, agile: true }))).toEqual({ events: false, agile: true, outlook: false });
    expect(parseToggles(JSON.stringify({ agile: true }))).toEqual({ ...DEFAULT_TOGGLES, agile: true });
  });

  it("anything else falls back, rather than throwing or turning on by accident", () => {
    expect(parseToggles("{not json")).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("[true,true]")).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles(JSON.stringify({ agile: "yes", events: 0 }))).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("null")).toEqual(DEFAULT_TOGGLES);
  });

  it("unknown keys are not carried along", () => {
    expect(Object.keys(parseToggles(JSON.stringify({ agile: true, extra: true })))).toEqual(["events", "agile", "outlook"]);
  });

  it("Outlook is off on a first visit: a person's own mailbox is never shown until they ask", () => {
    expect(DEFAULT_TOGGLES.outlook).toBe(false);
    expect(parseToggles(JSON.stringify({ outlook: "yes" })).outlook).toBe(false);
  });

  it("the store is per org AND per person", () => {
    expect(togglesStorageKey("o1", "u1")).not.toBe(togglesStorageKey("o1", "u2"));
    expect(togglesStorageKey("o1", "u1")).not.toBe(togglesStorageKey("o2", "u1"));
  });
});

describe("the viewer's Outlook events are drawn on the viewer's clock", () => {
  it("an instant reads as its wall time in the zone, expressed as UTC", () => {
    // 01:00 UTC on the 4th is 17:00 on the 3rd in Los Angeles (PST, UTC-8).
    expect(wallClock(D("2027-12-04T01:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2027-12-03T17:00:00.000Z");
    // The zone's own rules, not a fixed offset: in summer it is UTC-7.
    expect(wallClock(D("2027-07-04T01:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2027-07-03T18:00:00.000Z");
    // Control: in UTC nothing moves.
    expect(wallClock(D("2027-12-04T01:00:00Z"), "UTC").toISOString()).toBe("2027-12-04T01:00:00.000Z");
  });

  const payload: OutlookPayload = {
    status: "connected",
    capped: false,
    events: [
      { id: "t", subject: "Program review", start: "2027-12-04T01:00:00.000Z", end: "2027-12-04T02:00:00.000Z", allDay: false, webLink: "https://outlook.example/1" },
      { id: "a", subject: "Exercise A", start: "2027-12-08T00:00:00.000Z", end: "2027-12-10T00:00:00.000Z", allDay: true, webLink: null },
    ],
  };

  it("a meeting late in the viewer's day stays on that day, at that time", () => {
    const [t] = outlookItems(payload, "America/Los_Angeles");
    expect(t.startsAt.toISOString()).toBe("2027-12-03T17:00:00.000Z");
    expect(t.endsAt.toISOString()).toBe("2027-12-03T18:00:00.000Z");
    expect(t).toMatchObject({ allDay: false, timeZone: "UTC", kind: "outlook", rank: KIND_RANK.outlook, href: "https://outlook.example/1" });
    expect(t.description).toBe("Outlook: Program review, 17:00 to 18:00");
  });

  it("an all-day event keeps its dates in every zone, and with no link has none", () => {
    for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
      const a = outlookItems(payload, zone)[1];
      expect(a.startsAt.toISOString()).toBe("2027-12-08T00:00:00.000Z");
      expect(a.endsAt.toISOString()).toBe("2027-12-10T00:00:00.000Z");
      expect(a.allDay).toBe(true);
      expect(a.href).toBeUndefined();
    }
  });

  it("sits under the cadence and above due dates", () => {
    expect(KIND_RANK.outlook).toBeGreaterThan(KIND_RANK.sprint);
    expect(KIND_RANK.outlook).toBeLessThan(KIND_RANK.due);
  });
});
