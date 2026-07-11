import { describe, it, expect } from "vitest";
import {
  deriveChildType,
  fallbackChildTypeKey,
  type ChildTypeCandidate,
} from "@/lib/work-items/child-type";

// Mirrors the built-in software hierarchy (prisma/seed/sectors/software.ts):
// story is the child of epic; task and subtask are both children of story.
const SOFTWARE: ChildTypeCandidate[] = [
  { id: "epic", key: "software.epic", sortOrder: 0, defaultParentTypeKey: null },
  { id: "story", key: "software.story", sortOrder: 1, defaultParentTypeKey: "software.epic" },
  { id: "task", key: "software.task", sortOrder: 2, defaultParentTypeKey: "software.story" },
  { id: "bug", key: "software.bug", sortOrder: 3, defaultParentTypeKey: null },
  { id: "subtask", key: "software.subtask", sortOrder: 4, defaultParentTypeKey: "software.story" },
];

describe("deriveChildType", () => {
  it("defaults a sub-item under an Epic to Story (AC1)", () => {
    expect(deriveChildType("software.epic", SOFTWARE)?.id).toBe("story");
  });

  it("defaults a sub-item under a Story to Task, not Subtask (AC2)", () => {
    // Both Task and Subtask name Story as their parent; the lower sortOrder
    // (Task) wins so a Story's default child is a Task.
    expect(deriveChildType("software.story", SOFTWARE)?.id).toBe("task");
  });

  it("returns the lowest-sortOrder child regardless of array order", () => {
    const shuffled = [...SOFTWARE].reverse();
    expect(deriveChildType("software.story", shuffled)?.id).toBe("task");
  });

  it("returns null when the parent has no hierarchy child (Task/Bug)", () => {
    expect(deriveChildType("software.task", SOFTWARE)).toBeNull();
    expect(deriveChildType("software.bug", SOFTWARE)).toBeNull();
  });

  it("returns null for an unknown parent key or when types are empty", () => {
    expect(deriveChildType("software.epic", [])).toBeNull();
    expect(deriveChildType(undefined, SOFTWARE)).toBeNull();
    expect(deriveChildType("nope.whatever", SOFTWARE)).toBeNull();
  });

  it("is sector-agnostic — works for a custom hierarchy (AC: derived from hierarchy)", () => {
    const okr: ChildTypeCandidate[] = [
      { id: "obj", key: "objective", sortOrder: 0, defaultParentTypeKey: null },
      { id: "kr", key: "key_result", sortOrder: 1, defaultParentTypeKey: "objective" },
    ];
    expect(deriveChildType("objective", okr)?.id).toBe("kr");
  });
});

describe("fallbackChildTypeKey", () => {
  it("maps the software hierarchy one level down", () => {
    expect(fallbackChildTypeKey("software.epic")).toBe("STORY");
    expect(fallbackChildTypeKey("software.story")).toBe("TASK");
    expect(fallbackChildTypeKey("software.task")).toBe("SUBTASK");
    expect(fallbackChildTypeKey("software.bug")).toBe("SUBTASK");
  });

  it("matches on the bare suffix and is case-insensitive", () => {
    expect(fallbackChildTypeKey("epic")).toBe("STORY");
    expect(fallbackChildTypeKey("EPIC")).toBe("STORY");
  });

  it("defaults to TASK for unknown or missing parent keys", () => {
    expect(fallbackChildTypeKey(undefined)).toBe("TASK");
    expect(fallbackChildTypeKey("marketing.campaign")).toBe("TASK");
  });
});
