// COSMOS-202: a person's feed shows their dated work, their meetings and
// (optionally) their sprints, and "busy only" hides everything but the time.
import { describe, it, expect } from "vitest";
import { DEFAULT_FEED_OPTIONS, feedEvents, MEETING_MINUTES, type FeedOptions } from "./feed-events";

const D = (s: string) => new Date(s);
const base = {
  origin: "https://example.com",
  orgSlug: "alpha",
  uidHost: "example.com",
  workItems: [
    { id: "w1", ticketNumber: 7, projectKey: "ALPHA", title: "Ship it", startDate: D("2026-10-20T00:00:00Z"), dueDate: D("2026-10-24T00:00:00Z"), updatedAt: D("2026-10-01T00:00:00Z") },
    { id: "w2", ticketNumber: 8, projectKey: "ALPHA", title: "Due only", startDate: null, dueDate: D("2026-10-30T00:00:00Z"), updatedAt: D("2026-10-01T00:00:00Z") },
    { id: "w3", ticketNumber: 9, projectKey: "ALPHA", title: "Undated", startDate: null, dueDate: null, updatedAt: D("2026-10-01T00:00:00Z") },
  ],
  meetings: [{ id: "m1", title: "Standup", meetingDate: D("2026-10-23T14:30:00Z"), updatedAt: D("2026-10-01T00:00:00Z") }],
  intervals: [{ id: "i1", name: "Sprint 4", projectKey: "ALPHA", startDate: D("2026-10-19T00:00:00Z"), endDate: D("2026-11-01T00:00:00Z"), updatedAt: D("2026-10-01T00:00:00Z") }],
};
const run = (o: Partial<FeedOptions> = {}) => feedEvents({ ...base, options: { ...DEFAULT_FEED_OPTIONS, ...o } });

describe("feedEvents", () => {
  it("spans a work item from its start to its due date, inclusive", () => {
    const e = run().find((x) => x.uid === "workitem-w1@example.com")!;
    expect(e).toMatchObject({ allDay: true, summary: "ALPHA-7 Ship it", url: "https://example.com/alpha/issues?item=ALPHA-7" });
    expect(e.start.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(e.end.toISOString()).toBe("2026-10-25T00:00:00.000Z"); // exclusive: the day after the due date
  });

  it("puts a due-only item on its due date, and leaves undated work out", () => {
    const evs = run();
    const due = evs.find((x) => x.uid === "workitem-w2@example.com")!;
    expect(due.start.toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(due.end.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(evs.some((x) => x.uid.startsWith("workitem-w3"))).toBe(false);
  });

  it("gives a meeting a fixed length, since meetings have no end time", () => {
    const m = run().find((x) => x.uid === "meeting-m1@example.com")!;
    expect(m.allDay).toBe(false);
    expect(m.end.getTime() - m.start.getTime()).toBe(MEETING_MINUTES * 60_000);
    expect(m.url).toBe("https://example.com/alpha/meetings/m1");
  });

  it("includes sprints only when asked", () => {
    expect(run().some((x) => x.uid.startsWith("interval-"))).toBe(false);
    const i = run({ intervals: true }).find((x) => x.uid === "interval-i1@example.com")!;
    expect(i.summary).toBe("ALPHA: Sprint 4");
    expect(i.end.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("honours each source switch", () => {
    expect(run({ workItems: false }).some((x) => x.uid.startsWith("workitem-"))).toBe(false);
    expect(run({ meetings: false }).some((x) => x.uid.startsWith("meeting-"))).toBe(false);
  });

  it("busy-only shows the time and nothing else", () => {
    const evs = run({ busyOnly: true, intervals: true });
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) {
      expect(e.summary).toBe("Busy");
      expect(e.url ?? null).toBeNull();
      expect(e.description ?? null).toBeNull();
    }
  });
});
