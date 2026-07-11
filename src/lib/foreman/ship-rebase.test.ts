import { describe, it, expect } from "vitest";
import {
  nextVersion,
  extractTopChangelogEntry,
  prependChangelogEntry,
  conflictsAreMechanical,
} from "./ship-rebase";

const CHANGELOG = `export const CHANGELOG: Release[] = [
  {
    version: "2.181.0",
    date: "2026-07-11",
    title: "Feedback shows “In review” distinctly",
    highlights: [
      { kind: "improvement", text: "nested { braces } inside strings are fine." },
    ],
  },
  {
    version: "2.180.0",
    date: "2026-07-11",
    title: "Older",
    highlights: [{ kind: "fix", text: "x" }],
  },
];`;

describe("nextVersion", () => {
  it("bumps patch and minor per the build rule", () => {
    expect(nextVersion("2.181.0", "patch")).toBe("2.181.1");
    expect(nextVersion("2.181.3", "minor")).toBe("2.182.0");
    expect(nextVersion("2.181", "patch")).toBe("2.181.1"); // tolerant of short forms
  });
});

describe("extractTopChangelogEntry", () => {
  it("returns the newest entry with balanced braces and its version", () => {
    const top = extractTopChangelogEntry(CHANGELOG)!;
    expect(top.version).toBe("2.181.0");
    expect(top.entry).toContain("In review");
    expect(top.entry).toContain("nested { braces } inside strings");
    expect(top.entry.trimEnd().endsWith(",")).toBe(true);
    expect(top.entry).not.toContain("2.180.0"); // stops at the first entry
  });

  it("returns null when there is no array/entry", () => {
    expect(extractTopChangelogEntry("export const x = 1;")).toBeNull();
  });
});

describe("prependChangelogEntry", () => {
  it("inserts the entry at the top with the corrected version", () => {
    const main = CHANGELOG; // main's newest is 2.181.0
    const built = extractTopChangelogEntry(
      CHANGELOG.replace("2.181.0", "2.181.0-branch").replace("In review", "My built feature"),
    )!;
    const out = prependChangelogEntry(main, built.entry, "2.182.0");
    const newTop = extractTopChangelogEntry(out)!;
    expect(newTop.version).toBe("2.182.0");
    expect(newTop.entry).toContain("My built feature");
    // main's old top is still second
    expect(out.indexOf("My built feature")).toBeLessThan(out.indexOf("In review"));
  });

  it("is idempotent when the target version is already on top (ship retry)", () => {
    const once = prependChangelogEntry(CHANGELOG, extractTopChangelogEntry(CHANGELOG)!.entry, "2.182.0");
    const twice = prependChangelogEntry(once, extractTopChangelogEntry(CHANGELOG)!.entry, "2.182.0");
    expect(twice).toBe(once);
  });
});

describe("conflictsAreMechanical", () => {
  it("accepts exactly the version-race trio", () => {
    expect(conflictsAreMechanical(["package.json", "src/lib/changelog.ts"])).toBe(true);
    expect(conflictsAreMechanical(["package.json", "package-lock.json", "src/lib/changelog.ts"])).toBe(true);
  });
  it("rejects anything else (must abort → park)", () => {
    expect(conflictsAreMechanical(["package.json", "src/lib/foo.ts"])).toBe(false);
    expect(conflictsAreMechanical([])).toBe(false);
  });
});
