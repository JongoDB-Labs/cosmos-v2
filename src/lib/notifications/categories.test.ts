import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_CATEGORIES,
  categoryMatchesType,
  categoryTypeFilter,
  notificationTypeLabel,
} from "./categories";

describe("notification categories", () => {
  it("matches types to their domain-prefix category", () => {
    expect(categoryMatchesType("comment", "comment.added")).toBe(true);
    expect(categoryMatchesType("assignment", "work_item.assigned")).toBe(true);
    expect(categoryMatchesType("chat", "chat.dm")).toBe(true);
    expect(categoryMatchesType("delivery", "delivery.shipped")).toBe(true);
    expect(categoryMatchesType("meeting", "meeting.invited")).toBe(true);
    expect(categoryMatchesType("comment", "work_item.assigned")).toBe(false);
  });

  it("treats Mentions as a cross-cutting category over any *.mentioned type", () => {
    expect(categoryMatchesType("mention", "comment.mentioned")).toBe(true);
    expect(categoryMatchesType("mention", "note.mentioned")).toBe(true);
    expect(categoryMatchesType("mention", "chat.mentioned")).toBe(true);
    expect(categoryMatchesType("mention", "chat.dm")).toBe(false);
  });

  it("returns false for unknown category keys", () => {
    expect(categoryMatchesType("nope", "comment.added")).toBe(false);
  });

  it("builds a Prisma type filter for a category, and null for all/unknown", () => {
    expect(categoryTypeFilter("comment")).toEqual({ startsWith: "comment." });
    expect(categoryTypeFilter("mention")).toEqual({ endsWith: ".mentioned" });
    expect(categoryTypeFilter("all")).toBeNull();
    expect(categoryTypeFilter(null)).toBeNull();
    expect(categoryTypeFilter(undefined)).toBeNull();
    expect(categoryTypeFilter("bogus")).toBeNull();
  });

  it("labels a single notification type, preferring the specific Mention", () => {
    expect(notificationTypeLabel("comment.mentioned")).toBe("Mention");
    expect(notificationTypeLabel("note.mentioned")).toBe("Mention");
    expect(notificationTypeLabel("comment.added")).toBe("Comment");
    expect(notificationTypeLabel("work_item.assigned")).toBe("Assignment");
    expect(notificationTypeLabel("delivery.shipped")).toBe("Delivery");
  });

  it("humanizes an unknown type's domain as a fallback label", () => {
    expect(notificationTypeLabel("release.published")).toBe("Release");
    expect(notificationTypeLabel("status_change.updated")).toBe("Status change");
  });

  it("exposes a stable, non-empty category list", () => {
    expect(NOTIFICATION_CATEGORIES.length).toBeGreaterThan(0);
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(c.key).toBeTruthy();
      expect(c.label).toBeTruthy();
      // Each category matches on exactly one of prefix/suffix.
      expect(Boolean(c.prefix) !== Boolean(c.suffix)).toBe(true);
    }
  });
});
