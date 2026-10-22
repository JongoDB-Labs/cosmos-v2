import { describe, it, expect } from "vitest";
import { toCSV, parseCSV } from "./csv";

// COSMOS-200: a cell beginning with = + - @ (or TAB / CR) is executed as a
// formula when a spreadsheet opens the file (OWASP "CSV Injection"). Anyone who
// can type a work-item title or a time-entry description could plant one that
// runs on the machine of whoever exports it.
const cell = (value: unknown) => parseCSV(toCSV([{ v: value }])).rows[0].v;

describe("toCSV — formula injection", () => {
  it.each([
    ["=", '=HYPERLINK("http://evil.example","click")'],
    ["+", "+cmd|' /C calc'!A0"],
    ["-", "-2+3+cmd|' /C calc'!A0"],
    ["@", "@SUM(1+1)*cmd|' /C calc'!A0"],
    ["TAB", "\t=1+1"],
    ["CR", "\r=1+1"],
  ])("neutralizes a cell starting with %s", (_char, value) => {
    expect(cell(value)).toBe("'" + value);
  });

  it("keeps real numbers intact: a JS number is never prefixed", () => {
    expect(cell(-3)).toBe("-3");
    expect(cell(-0.5)).toBe("-0.5");
  });

  it.each(["-3", "+1.5", "-1e5", "1e-3", "0"])(
    "keeps a string that is only a number (%s) as-is, since spreadsheets read it as a value",
    (value) => {
      expect(cell(value)).toBe(value);
    },
  );

  it("leaves ordinary text alone, including a trigger character later in the cell", () => {
    expect(cell("Fix the importer")).toBe("Fix the importer");
    expect(cell("a = b + c")).toBe("a = b + c");
    expect(cell("user@example.com")).toBe("user@example.com");
  });

  it("still round-trips commas, quotes and newlines", () => {
    const value = 'one, "two"\nthree';
    expect(cell(value)).toBe(value);
  });

  it("neutralizes inside a quoted cell too", () => {
    expect(cell('=1+1, "x"')).toBe("'=1+1, \"x\"");
  });
});
