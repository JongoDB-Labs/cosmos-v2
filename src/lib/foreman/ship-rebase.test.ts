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

import { classifyConflict, describeMergeFailure, VERSION_RACE_TRIO } from "./ship-rebase";

describe("VERSION_RACE_TRIO", () => {
  it("is exactly the three mechanically-resolvable files", () => {
    expect([...VERSION_RACE_TRIO].sort()).toEqual(
      ["package-lock.json", "package.json", "src/lib/changelog.ts"].sort(),
    );
  });
});

describe("classifyConflict", () => {
  it("classifies the exact version-race trio as mechanical", () => {
    expect(classifyConflict(["package.json", "src/lib/changelog.ts"])).toBe("mechanical");
    expect(classifyConflict([...VERSION_RACE_TRIO])).toBe("mechanical");
  });
  it("classifies any real code path as cross-phase", () => {
    expect(classifyConflict(["src/app/board/sprint-board.tsx"])).toBe("cross-phase");
    expect(classifyConflict(["package.json", "src/lib/foo.ts"])).toBe("cross-phase");
  });
  it("classifies an empty conflicted set (git failed with no conflicts) as opaque", () => {
    expect(classifyConflict([])).toBe("opaque");
  });
});

describe("describeMergeFailure", () => {
  it("names the phase and files on a cross-phase code conflict", () => {
    const msg = describeMergeFailure({
      phaseRef: "COSMOS-120",
      conflictedPaths: ["src/app/board/sprint-board.tsx"],
    });
    expect(msg).toContain("COSMOS-120");
    expect(msg).toContain("src/app/board/sprint-board.tsx");
    expect(msg).not.toContain("unknown");
  });
  it("surfaces raw git stderr (never 'unknown') when git reported no conflicted paths", () => {
    const msg = describeMergeFailure({
      phaseRef: "COSMOS-121",
      conflictedPaths: [],
      gitStderr: "fatal: refusing to merge unrelated histories",
    });
    expect(msg).toContain("COSMOS-121");
    expect(msg).toContain("refusing to merge unrelated histories");
    expect(msg).not.toContain("unknown");
  });
  it("still attributes the phase when git gave no conflicts and no stderr", () => {
    const msg = describeMergeFailure({ phaseRef: "COSMOS-122", conflictedPaths: [] });
    expect(msg).toContain("COSMOS-122");
    expect(msg).not.toContain("unknown");
  });
  it("labels a trio-only conflict as mechanical (not a hard abort)", () => {
    const msg = describeMergeFailure({
      phaseRef: "COSMOS-123",
      conflictedPaths: ["package.json", "src/lib/changelog.ts"],
    });
    expect(msg).toContain("version-race trio");
  });
});
