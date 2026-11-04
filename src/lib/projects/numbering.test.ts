import { describe, it, expect } from "vitest";
import {
  projectNumbering,
  validatePattern,
  validateNamePattern,
  formatProjectNumber,
  sequenceOf,
  nextProjectNumber,
  applyNamePattern,
} from "./numbering";

describe("formatProjectNumber", () => {
  it("YY-NNN", () => expect(formatProjectNumber("YY-NNN", 2026, 7)).toBe("26-007"));
  it("YYYY.NNNN", () => expect(formatProjectNumber("YYYY.NNNN", 2026, 42)).toBe("2026.0042"));
  it("widens past its width instead of wrapping", () => expect(formatProjectNumber("YY-NNN", 2026, 1000)).toBe("26-1000"));
  it("pads a two-digit year", () => expect(formatProjectNumber("YY-NN", 2005, 1)).toBe("05-01"));
  it("literals stay literal", () => expect(formatProjectNumber("P-NNN", 2026, 3)).toBe("P-003"));
});

describe("nextProjectNumber", () => {
  it("starts the year at 1", () => expect(nextProjectNumber("YY-NNN", 2026, [])).toBe("26-001"));

  it("is one past the HIGHEST this year, not the count — a gap is never refilled", () => {
    expect(nextProjectNumber("YY-NNN", 2026, ["26-001", "26-004", null])).toBe("26-005");
  });

  it("restarts each year: last year's numbers don't count", () => {
    expect(nextProjectNumber("YY-NNN", 2027, ["26-001", "26-002"])).toBe("27-001");
  });

  it("ignores numbers that don't fit the pattern (imported, or an older standard)", () => {
    expect(nextProjectNumber("YY-NNN", 2026, ["2026-050", "J1234", "26-003"])).toBe("26-004");
  });

  it("without a year token it just counts up", () => {
    expect(nextProjectNumber("P-NNN", 2027, ["P-009"])).toBe("P-010");
  });

  it("continues past the padded width", () => {
    expect(nextProjectNumber("YY-NNN", 2026, ["26-999"])).toBe("26-1000");
    expect(nextProjectNumber("YY-NNN", 2026, ["26-1000"])).toBe("26-1001");
  });

  it("a pattern character that is a regex metacharacter is matched literally", () => {
    expect(sequenceOf("YY.NNN", 2026, "26X001")).toBeNull();
    expect(sequenceOf("YY.NNN", 2026, "26.001")).toBe(1);
  });
});

describe("validatePattern", () => {
  it.each(["YY-NNN", "YYYY-NNNN", "P-NNN", "YY/NN"])("accepts %s", (p) => expect(validatePattern(p)).toBeNull());
  it.each([
    ["", /Enter a pattern/],
    ["YY-", /exactly one run of N/],
    ["NN-NN", /exactly one run of N/],
    ["YY-NNNNNNN", /six/],
    ["YY-YYYY-NN", /year at most once/],
    ["YY#NN", /letters, digits/],
  ])("refuses %j", (p, why) => expect(validatePattern(p)).toMatch(why));
});

describe("validateNamePattern", () => {
  it("needs {name}", () => expect(validateNamePattern("{number}")).toMatch(/\{name\}/));
  it("refuses an unknown placeholder", () => expect(validateNamePattern("{number} {client} {name}")).toMatch(/\{client\}/));
  it("accepts {number} {name}", () => expect(validateNamePattern("{number} {name}")).toBeNull());
});

describe("applyNamePattern", () => {
  it("fills the pattern", () =>
    expect(applyNamePattern("{number} {name}", { name: "Riverside Library", number: "26-001" })).toBe(
      "26-001 Riverside Library",
    ));
  it("no number: the name as typed", () => expect(applyNamePattern("{number} {name}", { name: "X", number: null })).toBe("X"));
  it("no pattern: the name as typed", () => expect(applyNamePattern(null, { name: "X", number: "26-001" })).toBe("X"));
});

describe("projectNumbering (org settings)", () => {
  it("off when unset", () => expect(projectNumbering({})).toEqual({ pattern: null, namePattern: null }));
  it("reads a valid standard", () =>
    expect(projectNumbering({ projects: { numbering: { pattern: "YY-NNN", namePattern: "{number} {name}" } } })).toEqual({
      pattern: "YY-NNN",
      namePattern: "{number} {name}",
    }));
  it("treats a stored pattern that no longer validates as off, rather than numbering wrongly", () =>
    expect(projectNumbering({ projects: { numbering: { pattern: "YY-" } } }).pattern).toBeNull());
});
