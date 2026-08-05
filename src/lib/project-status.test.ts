import { describe, it, expect } from "vitest";
import { ProjectStatus } from "@prisma/client";
import {
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_ORDER,
  projectStatusLabel,
  isLiveStatus,
} from "./project-status";

/**
 * The point of moving status out of `settings` was to have ONE closed set of
 * values. These tests guard that: every member is spelled for a reader and
 * offered in a dropdown, and nothing archival leaks back in.
 */

describe("project status vocabulary", () => {
  const members = Object.values(ProjectStatus);

  it("covers every enum member, so none can render as a raw value", () => {
    for (const s of members) {
      expect(PROJECT_STATUS_LABELS[s], `no label for ${s}`).toBeTruthy();
    }
  });

  it("offers every member in the dropdown order, exactly once", () => {
    expect([...PROJECT_STATUS_ORDER].sort()).toEqual([...members].sort());
    expect(new Set(PROJECT_STATUS_ORDER).size).toBe(PROJECT_STATUS_ORDER.length);
  });

  it("has NO archived member — archival is projects.archived, a separate axis", () => {
    // Two fields able to disagree about whether a project is archived is the
    // exact problem this enum was introduced to remove.
    expect(members).not.toContain("ARCHIVED");
  });

  it("orders by lifecycle rather than alphabetically", () => {
    expect(PROJECT_STATUS_ORDER[0]).toBe(ProjectStatus.DRAFT);
    expect(PROJECT_STATUS_ORDER.at(-1)).toBe(ProjectStatus.COMPLETE);
  });
});

describe("projectStatusLabel", () => {
  it("reads as prose, not as a database value", () => {
    expect(projectStatusLabel(ProjectStatus.ON_HOLD)).toBe("On hold");
  });

  it("falls back to the raw value rather than rendering blank", () => {
    // A row written before the enum existed should still show SOMETHING.
    expect(projectStatusLabel("LEGACY_THING")).toBe("LEGACY_THING");
  });
});

describe("isLiveStatus", () => {
  it("counts work in flight and work paused as live", () => {
    expect(isLiveStatus(ProjectStatus.ACTIVE)).toBe(true);
    // On hold is paused, not finished — it still has scope owed.
    expect(isLiveStatus(ProjectStatus.ON_HOLD)).toBe(true);
  });

  it("excludes what has not started and what is finished", () => {
    expect(isLiveStatus(ProjectStatus.DRAFT)).toBe(false);
    expect(isLiveStatus(ProjectStatus.COMPLETE)).toBe(false);
  });
});
