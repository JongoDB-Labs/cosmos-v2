import { describe, expect, it } from "vitest";
import {
  plannerPrompt,
  parsePlannerPicks,
  isStandingDemotion,
  PLAN_TARGET,
  type PlannerCandidate,
} from "./planner";

// Fixed reference "now" so relative offsets are deterministic.
const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const DAY = 86_400_000;
/** A date `offset` relative to the fixed NOW: "0" = now, "-3d" = 3 days before. */
function d(offset: string): Date {
  if (offset === "0") return new Date(NOW);
  const m = offset.match(/^(-?\d+)d$/);
  if (!m) throw new Error(`bad offset: ${offset}`);
  return new Date(NOW + parseInt(m[1], 10) * DAY);
}

function cand(over: Partial<PlannerCandidate> = {}): PlannerCandidate {
  return {
    key: "COSMOS-1",
    title: "Title one",
    description: "Desc one",
    priority: "HIGH",
    feedbackType: "BUG",
    severity: "high",
    voteCount: 5,
    ageDays: 3,
    ...over,
  };
}

describe("PLAN_TARGET", () => {
  it("is pinned to 3", () => {
    expect(PLAN_TARGET).toBe(3);
  });
});

describe("plannerPrompt", () => {
  it("includes every candidate's key, votes, type and age, and states the JSON-only contract with the slot count", () => {
    const candidates = [
      cand({ key: "COSMOS-1", voteCount: 5, feedbackType: "BUG", ageDays: 3 }),
      cand({ key: "COSMOS-2", voteCount: 12, feedbackType: "FEATURE", ageDays: 40 }),
    ];
    const prompt = plannerPrompt(candidates, 2);
    for (const c of candidates) {
      expect(prompt).toContain(c.key);
      expect(prompt).toContain(`votes:${c.voteCount}`);
      expect(prompt).toContain(c.feedbackType as string);
      expect(prompt).toContain(`age:${c.ageDays}d`);
    }
    // JSON-only output contract + the number of slots to pick.
    expect(prompt).toMatch(/JSON array/i);
    expect(prompt).toContain('"key"');
    expect(prompt).toContain('"why"');
    expect(prompt).toContain("Pick the 2 tickets");
  });

  it("renders null feedbackType/severity/voteCount with safe defaults", () => {
    const prompt = plannerPrompt(
      [cand({ key: "COSMOS-9", feedbackType: null, severity: null, voteCount: null })],
      1,
    );
    expect(prompt).toContain("COSMOS-9");
    expect(prompt).toContain("ticket/-"); // feedbackType ?? "ticket" / severity ?? "-"
    expect(prompt).toContain("votes:0"); // voteCount ?? 0
  });

  it("truncates a long description to 200 chars in its digest line", () => {
    const prompt = plannerPrompt([cand({ description: "z".repeat(500) })], 1);
    expect(prompt).toContain("z".repeat(200));
    expect(prompt).not.toContain("z".repeat(201));
  });
});

describe("parsePlannerPicks", () => {
  const valid = new Set(["COSMOS-1", "COSMOS-2", "COSMOS-3"]);

  it("parses a clean JSON array", () => {
    const raw = '[{"key":"COSMOS-1","why":"top ROI"},{"key":"COSMOS-2","why":"many votes"}]';
    expect(parsePlannerPicks(raw, valid, 3)).toEqual([
      { key: "COSMOS-1", why: "top ROI" },
      { key: "COSMOS-2", why: "many votes" },
    ]);
  });

  it("extracts an array embedded in prose", () => {
    const raw = 'Sure! My picks:\n[{"key":"COSMOS-1","why":"fix crash"}]\nHope that helps.';
    expect(parsePlannerPicks(raw, valid, 3)).toEqual([{ key: "COSMOS-1", why: "fix crash" }]);
  });

  it("returns [] on invalid JSON or when no array is present", () => {
    expect(parsePlannerPicks("[not json at all", valid, 3)).toEqual([]);
    expect(parsePlannerPicks("no array here", valid, 3)).toEqual([]);
    expect(parsePlannerPicks("", valid, 3)).toEqual([]);
  });

  it("filters out keys not in validKeys", () => {
    const raw = '[{"key":"NOPE-9","why":"x"},{"key":"COSMOS-2","why":"y"}]';
    expect(parsePlannerPicks(raw, valid, 3)).toEqual([{ key: "COSMOS-2", why: "y" }]);
  });

  it("dedupes duplicate keys (first wins)", () => {
    const raw = '[{"key":"COSMOS-1","why":"first"},{"key":"COSMOS-1","why":"second"}]';
    expect(parsePlannerPicks(raw, valid, 3)).toEqual([{ key: "COSMOS-1", why: "first" }]);
  });

  it("caps the result at max", () => {
    const raw =
      '[{"key":"COSMOS-1","why":"a"},{"key":"COSMOS-2","why":"b"},{"key":"COSMOS-3","why":"c"}]';
    expect(parsePlannerPicks(raw, valid, 2)).toEqual([
      { key: "COSMOS-1", why: "a" },
      { key: "COSMOS-2", why: "b" },
    ]);
  });

  it("truncates why to 140 chars and defaults a missing why to ''", () => {
    const long = "x".repeat(200);
    const raw = `[{"key":"COSMOS-1","why":"${long}"},{"key":"COSMOS-2"}]`;
    const picks = parsePlannerPicks(raw, valid, 3);
    expect(picks[0].why).toHaveLength(140);
    expect(picks[1]).toEqual({ key: "COSMOS-2", why: "" });
  });

  it("skips non-object entries and entries whose key is not a string", () => {
    const raw = '["COSMOS-1", {"why":"no key"}, {"key":123}, {"key":"COSMOS-3","why":"ok"}]';
    expect(parsePlannerPicks(raw, valid, 3)).toEqual([{ key: "COSMOS-3", why: "ok" }]);
  });
});

describe("isStandingDemotion", () => {
  const base = {
    plannedAt: d("-3d"),
    demotedAt: d("-2d"),
    updatedAt: d("-2d"),
    lastCommentAt: null as Date | null,
    now: d("0"),
  };

  it("true: foreman-promoted, human-demoted, untouched, fresh", () => {
    expect(isStandingDemotion(base)).toBe(true);
  });
  it("false: never foreman-planned → not a demotion", () => {
    expect(isStandingDemotion({ ...base, plannedAt: null })).toBe(false);
  });
  it("false: planned AFTER the demotion → stale fact", () => {
    expect(isStandingDemotion({ ...base, plannedAt: d("-1d") })).toBe(false);
  });
  it("false: edited since → re-eligible", () => {
    expect(isStandingDemotion({ ...base, updatedAt: d("-1d") })).toBe(false);
  });
  it("false: commented since → re-eligible", () => {
    expect(isStandingDemotion({ ...base, lastCommentAt: d("-1d") })).toBe(false);
  });
  it("false: 7-day window elapsed", () => {
    expect(isStandingDemotion({ ...base, demotedAt: d("-8d") })).toBe(false);
  });

  // Extra rigor beyond the brief's table:
  it("true: a comment BEFORE the demotion does not re-open it", () => {
    expect(isStandingDemotion({ ...base, lastCommentAt: d("-3d") })).toBe(true);
  });
  it("isolates the window boundary: 8d-old demotion is stale, 6d-old still stands", () => {
    const elapsed = { plannedAt: d("-9d"), demotedAt: d("-8d"), updatedAt: d("-9d"), lastCommentAt: null, now: d("0") };
    const fresh = { plannedAt: d("-7d"), demotedAt: d("-6d"), updatedAt: d("-7d"), lastCommentAt: null, now: d("0") };
    expect(isStandingDemotion(elapsed)).toBe(false);
    expect(isStandingDemotion(fresh)).toBe(true);
  });
});
