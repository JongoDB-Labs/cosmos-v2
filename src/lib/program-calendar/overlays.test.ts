// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  agileItems,
  daySpan,
  DEFAULT_TOGGLES,
  KIND_RANK,
  milestoneItems,
  parseToggles,
  togglesStorageKey,
  type AgilePayload,
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
    expect(parseToggles(JSON.stringify({ events: false, agile: true }))).toEqual({ events: false, agile: true });
    expect(parseToggles(JSON.stringify({ agile: true }))).toEqual({ ...DEFAULT_TOGGLES, agile: true });
  });

  it("anything else falls back, rather than throwing or turning on by accident", () => {
    expect(parseToggles("{not json")).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("[true,true]")).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles(JSON.stringify({ agile: "yes", events: 0 }))).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("null")).toEqual(DEFAULT_TOGGLES);
  });

  it("unknown keys are not carried along", () => {
    expect(Object.keys(parseToggles(JSON.stringify({ agile: true, extra: true })))).toEqual(["events", "agile"]);
  });

  it("the store is per org AND per person", () => {
    expect(togglesStorageKey("o1", "u1")).not.toBe(togglesStorageKey("o1", "u2"));
    expect(togglesStorageKey("o1", "u1")).not.toBe(togglesStorageKey("o2", "u1"));
  });
});
