import { describe, it, expect } from "vitest";
import {
  byNewest,
  encodeCursor,
  decodeCursor,
  isBefore,
  mergePage,
  type FeedItem,
} from "./merge";

const at = (d: string, id: string): FeedItem => ({ at: d, id });

describe("byNewest", () => {
  it("puts the newest first", () => {
    expect([at("2026-01-01", "a"), at("2026-03-01", "b")].sort(byNewest).map((x) => x.id)).toEqual([
      "b", "a",
    ]);
  });

  it("breaks a tie by id, so the order is total", () => {
    // Without this the order of same-instant rows is whatever the sort happens
    // to do, and a cursor over them repeats or drops.
    const tied = [at("2026-01-01", "a"), at("2026-01-01", "c"), at("2026-01-01", "b")];
    expect(tied.sort(byNewest).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
});

describe("cursors", () => {
  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(at("2026-01-01T00:00:00.000Z", "x")))).toEqual(
      at("2026-01-01T00:00:00.000Z", "x"),
    );
  });

  it("treats a missing or malformed cursor as the top of the feed", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("no-separator")).toBeNull();
  });

  it("keeps an id containing the separator intact", () => {
    // Split on the FIRST bar only; an id is not guaranteed bar-free.
    expect(decodeCursor("2026-01-01|a|b")).toEqual({ at: "2026-01-01", id: "a|b" });
  });
});

describe("isBefore", () => {
  it("is everything when there is no cursor", () => {
    expect(isBefore(at("2026-01-01", "a"), null)).toBe(true);
  });

  it("excludes the cursor row itself", () => {
    const c = at("2026-01-01", "b");
    expect(isBefore(c, c)).toBe(false);
  });

  it("splits a tied instant by id rather than dropping the whole instant", () => {
    const c = at("2026-01-01", "b");
    expect(isBefore(at("2026-01-01", "a"), c)).toBe(true);  // still to come
    expect(isBefore(at("2026-01-01", "c"), c)).toBe(false); // already shown
  });
});

describe("mergePage", () => {
  const work = [at("2026-03-03", "w1"), at("2026-03-01", "w2")];
  const time = [at("2026-03-02", "t1"), at("2026-02-28", "t2")];

  it("interleaves the sources by time", () => {
    const { page } = mergePage([work, time], 10);
    expect(page.map((x) => x.id)).toEqual(["w1", "t1", "w2", "t2"]);
  });

  it("returns no cursor when everything fitted", () => {
    expect(mergePage([work, time], 10).nextCursor).toBeNull();
  });

  it("returns the last row as the cursor when there is more", () => {
    const { page, nextCursor } = mergePage([work, time], 2);
    expect(page.map((x) => x.id)).toEqual(["w1", "t1"]);
    expect(nextCursor).toBe(encodeCursor(at("2026-03-02", "t1")));
  });

  it("pages a run of identical timestamps without dropping or repeating one", () => {
    // The case that matters here: an import stamps hundreds of rows with the
    // same day. Paging on time alone loses all but the first.
    const bulk = ["e", "d", "c", "b", "a"].map((id) => at("2026-03-01", id));
    const seen: string[] = [];
    let cursor: FeedItem | null = null;
    for (let i = 0; i < 10; i++) {
      const { page, nextCursor } = mergePage([bulk], 2, cursor);
      seen.push(...page.map((x) => x.id));
      if (!nextCursor) break;
      cursor = decodeCursor(nextCursor);
    }
    expect(seen).toEqual(["e", "d", "c", "b", "a"]);
    expect(new Set(seen).size).toBe(seen.length); // nothing repeated
  });

  it("walks the whole feed across pages, in order, exactly once", () => {
    const all = [...work, ...time];
    const seen: string[] = [];
    let cursor: FeedItem | null = null;
    for (let i = 0; i < 10; i++) {
      const { page, nextCursor } = mergePage([work, time], 1, cursor);
      seen.push(...page.map((x) => x.id));
      if (!nextCursor) break;
      cursor = decodeCursor(nextCursor);
    }
    expect(seen).toEqual(["w1", "t1", "w2", "t2"]);
    expect(seen.length).toBe(all.length);
  });

  it("is empty, with no cursor, when every source is", () => {
    expect(mergePage([[], []], 5)).toEqual({ page: [], nextCursor: null });
  });
});
