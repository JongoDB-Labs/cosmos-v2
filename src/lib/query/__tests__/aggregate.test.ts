// The pure half of aggregation: folding item facts into groups.
import { describe, it, expect } from "vitest";
import { OTHER_ID, aggProblem, bucketOf, bucketRange, fold, type AggFact } from "../aggregate";

const one = (limit = 25) => [{ time: false, limit }];

describe("fold", () => {
  it("counts per group, and an empty value is its own group", () => {
    const facts: AggFact[] = [{ keys: [["a"]], value: null }, { keys: [["a"]], value: null }, { keys: [[]], value: null }];
    expect(fold(facts, one(), "count", "UTC").rows).toEqual([
      { keys: ["a"], value: 2, count: 2 },
      { keys: [null], value: 1, count: 1 },
    ]);
  });

  it("a multi-valued field counts the item once per value, never twice in one group", () => {
    const facts: AggFact[] = [{ keys: [["dana", "lee", "dana"]], value: 3 }];
    expect(fold(facts, one(), "sum", "UTC").rows).toEqual([
      { keys: ["dana"], value: 3, count: 1 },
      { keys: ["lee"], value: 3, count: 1 },
    ]);
  });

  it("two dimensions are the cross product of each item's values", () => {
    const facts: AggFact[] = [{ keys: [["a", "b"], ["x"]], value: null }, { keys: [["a"], ["y"]], value: null }];
    expect(fold(facts, [{ time: false, limit: 25 }, { time: false, limit: 25 }], "count", "UTC").rows.map((r) => r.keys)).toEqual([
      ["a", "x"], ["a", "y"], ["b", "x"],
    ]);
  });

  it("sum / avg / min / max skip items with no value; a group with none measures 0", () => {
    const facts: AggFact[] = [
      { keys: [["a"]], value: 2 },
      { keys: [["a"]], value: 6 },
      { keys: [["a"]], value: null },
      { keys: [["b"]], value: null },
    ];
    const v = (fn: "sum" | "avg" | "min" | "max") => Object.fromEntries(fold(facts, one(), fn, "UTC").rows.map((r) => [r.keys[0], [r.value, r.count]]));
    expect(v("sum")).toEqual({ a: [8, 3], b: [0, 1] });
    expect(v("avg")).toEqual({ a: [4, 3], b: [0, 1] });
    expect(v("min")).toEqual({ a: [2, 3], b: [0, 1] });
    expect(v("max")).toEqual({ a: [6, 3], b: [0, 1] });
  });

  it("past the limit, the smallest groups fold into Other, which sorts last", () => {
    const facts: AggFact[] = ["a", "a", "a", "b", "b", "c", "d"].map((k) => ({ keys: [[k]], value: null }));
    const r = fold(facts, one(2), "count", "UTC");
    expect(r.folded).toBe(true);
    expect(r.rows).toEqual([
      { keys: ["a"], value: 3, count: 3 },
      { keys: ["b"], value: 2, count: 2 },
      { keys: [OTHER_ID], value: 2, count: 2 },
    ]);
    expect(fold(facts, one(4), "count", "UTC").folded).toBe(false);
  });

  it("a time dimension keeps time order, fills empty buckets with zero, and puts 'no date' last", () => {
    const day = (s: string) => bucketOf(new Date(s), "day", "UTC");
    const facts: AggFact[] = [
      { keys: [[day("2026-10-03T10:00:00Z")]], value: null },
      { keys: [[day("2026-10-01T23:00:00Z")]], value: null },
      { keys: [[]], value: null },
    ];
    const r = fold(facts, [{ time: true, bucket: "day", limit: 25 }], "count", "UTC");
    expect(r.rows.map((x) => [x.keys[0], x.count])).toEqual([
      ["2026-10-01T00:00:00.000Z", 1],
      ["2026-10-02T00:00:00.000Z", 0],
      ["2026-10-03T00:00:00.000Z", 1],
      [null, 1],
    ]);
  });

  it("refuses more than a year of daily buckets rather than drawing them", () => {
    const facts: AggFact[] = [
      { keys: [[bucketOf(new Date("2024-01-01"), "day", "UTC")]], value: null },
      { keys: [[bucketOf(new Date("2026-01-01"), "day", "UTC")]], value: null },
    ];
    expect(() => fold(facts, [{ time: true, bucket: "day", limit: 25 }], "count", "UTC")).toThrow(RangeError);
  });
});

describe("buckets", () => {
  it("are periods in the request's time zone: a week starts on Monday, a month on the 1st", () => {
    // 23:30 on Sunday 2026-10-18 in Chicago is already Monday in UTC.
    const at = new Date("2026-10-19T04:30:00Z");
    expect(bucketOf(at, "week", "America/Chicago")).toBe(new Date("2026-10-12T05:00:00Z").toISOString());
    expect(bucketOf(at, "week", "UTC")).toBe("2026-10-19T00:00:00.000Z");
    expect(bucketOf(at, "month", "America/Chicago")).toBe(new Date("2026-10-01T05:00:00Z").toISOString());
    expect(bucketRange("2026-10-01T05:00:00.000Z", "2026-12-01T06:00:00.000Z", "month", "America/Chicago")).toHaveLength(3);
  });
});

describe("aggProblem", () => {
  const cf = new Map([["sev", "SELECT"], ["size", "NUMBER"], ["notes", "TEXT"], ["golive", "DATE"]] as const);
  const sys = (id: string) => ({ kind: "sys" as const, id }) as never;
  const count = { fn: "count" as const };
  it("takes groupable fields, date fields with a bucket, and number measures", () => {
    expect(aggProblem([{ field: sys("assignee") }, { field: sys("created"), bucket: "week" }], count, cf)).toBeNull();
    expect(aggProblem([{ field: { kind: "cf", key: "sev" } }, { field: { kind: "cf", key: "golive" }, bucket: "month" }], { fn: "avg", field: { kind: "cf", key: "size" } }, cf)).toBeNull();
    expect(aggProblem([], { fn: "sum", field: sys("points") }, cf)).toBeNull();
  });
  it("refuses the rest, saying why", () => {
    expect(aggProblem([{ field: sys("summary") }], count, cf)).toMatch(/Can't group by `summary`/);
    expect(aggProblem([{ field: sys("created") }], count, cf)).toMatch(/needs a bucket/);
    expect(aggProblem([{ field: sys("assignee"), bucket: "day" }], count, cf)).toMatch(/Only date fields/);
    expect(aggProblem([{ field: { kind: "cf", key: "notes" } }], count, cf)).toMatch(/text custom field/);
    expect(aggProblem([{ field: { kind: "cf", key: "nope" } }], count, cf)).toMatch(/Unknown custom field/);
    expect(aggProblem([], { fn: "sum", field: sys("priority") }, cf)).toMatch(/number custom field/);
    expect(aggProblem([{ field: sys("nope") }], count, cf)).toMatch(/Unknown field/);
  });
});
