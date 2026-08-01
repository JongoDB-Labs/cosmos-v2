import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { coversDate, rateOn, supersedingEffectiveTo } from "./resolve";

/**
 * Pinned to a negative-offset zone, like the other date suites. A rate boundary
 * that moves with the viewer's timezone would pay someone a different amount
 * depending on where they opened the page, and in UTC that is invisible.
 */
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

const card = (from: string, to: string | null, cost: string) => ({
  costRate: cost,
  billRate: null,
  effectiveFrom: from,
  effectiveTo: to,
});

/** A raise on 2026-04-01: 150 until then, 175 after. */
const HISTORY = [
  card("2026-01-01", "2026-04-01", "150.00"),
  card("2026-04-01", null, "175.00"),
];

describe("coversDate", () => {
  it("includes the first day", () => {
    expect(coversDate(card("2026-01-01", "2026-04-01", "150"), "2026-01-01")).toBe(true);
  });

  it("EXCLUDES the end day", () => {
    // Exclusive end is what lets consecutive cards abut without overlapping.
    expect(coversDate(card("2026-01-01", "2026-04-01", "150"), "2026-04-01")).toBe(false);
  });

  it("excludes the day before it starts", () => {
    expect(coversDate(card("2026-01-01", null, "150"), "2025-12-31")).toBe(false);
  });

  it("an open-ended card covers everything from its start", () => {
    expect(coversDate(card("2026-01-01", null, "150"), "2099-01-01")).toBe(true);
  });

  it("accepts a full ISO instant, taking the day", () => {
    expect(coversDate(card("2026-01-01T00:00:00.000Z", null, "150"), "2026-06-01T23:59:59.000Z")).toBe(true);
  });
});

describe("rateOn", () => {
  it("prices a March day at the OLD rate, after an April raise", () => {
    // The entire point: changing someone's pay must not re-price the past.
    expect(rateOn(HISTORY, "2026-03-31")?.costRate).toBe("150.00");
  });

  it("prices the raise day itself at the NEW rate", () => {
    expect(rateOn(HISTORY, "2026-04-01")?.costRate).toBe("175.00");
  });

  it("prices a later day at the new rate", () => {
    expect(rateOn(HISTORY, "2026-12-25")?.costRate).toBe("175.00");
  });

  it("returns null before any card exists", () => {
    // Not zero: "no rate on file" and "a rate of zero" are different facts, and
    // the caller decides what to do about the first.
    expect(rateOn(HISTORY, "2025-06-01")).toBeNull();
  });

  it("returns null for an empty history", () => {
    expect(rateOn([], "2026-06-01")).toBeNull();
  });

  it("is not sensitive to the order rows arrive in", () => {
    const reversed = [...HISTORY].reverse();
    expect(rateOn(reversed, "2026-03-31")?.costRate).toBe("150.00");
    expect(rateOn(reversed, "2026-04-01")?.costRate).toBe("175.00");
  });

  it("picks the LATEST start when intervals overlap", () => {
    // Overlaps are a data error an import can produce. Deciding by row order
    // would make someone's pay depend on how the query sorted.
    const overlapping = [
      card("2026-01-01", null, "150.00"),
      card("2026-03-01", null, "160.00"),
    ];
    expect(rateOn(overlapping, "2026-06-01")?.costRate).toBe("160.00");
    expect(rateOn([...overlapping].reverse(), "2026-06-01")?.costRate).toBe("160.00");
  });

  it("leaves a genuine GAP unpriced rather than guessing", () => {
    // A card that ended and nothing after it means nobody has said what the
    // rate is. Silently reusing the expired one would invent a fact.
    const gapped = [card("2026-01-01", "2026-02-01", "150.00")];
    expect(rateOn(gapped, "2026-03-01")).toBeNull();
  });
});

describe("supersedingEffectiveTo", () => {
  it("ends the old card exactly where the new one begins", () => {
    // Exclusive end: no gap on the boundary day, and no day covered twice.
    const boundary = "2026-04-01";
    const closed = card("2026-01-01", supersedingEffectiveTo(boundary), "150.00");
    const opened = card(boundary, null, "175.00");
    expect(coversDate(closed, "2026-03-31")).toBe(true);
    expect(coversDate(closed, boundary)).toBe(false);
    expect(coversDate(opened, boundary)).toBe(true);
    // Exactly one card covers the boundary day.
    expect([closed, opened].filter((c) => coversDate(c, boundary))).toHaveLength(1);
  });

  it("normalises an ISO instant to the day", () => {
    expect(supersedingEffectiveTo("2026-04-01T00:00:00.000Z")).toBe("2026-04-01");
  });
});
