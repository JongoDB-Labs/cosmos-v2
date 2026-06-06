import { describe, expect, it } from "vitest";
import { isInQuietHours } from "./quiet-hours";

function at(iso: string): Date {
  return new Date(iso);
}

describe("isInQuietHours", () => {
  it("returns false when DnD is disabled", () => {
    expect(isInQuietHours(at("2026-05-30T03:00:00Z"), { dndEnabled: false, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "UTC" })).toBe(false);
  });

  it("returns false when config is incomplete", () => {
    expect(isInQuietHours(at("2026-05-30T03:00:00Z"), { dndEnabled: true, dndStart: null, dndEnd: "07:00", dndTimezone: "UTC" })).toBe(false);
  });

  it("same-day window: inside", () => {
    expect(isInQuietHours(at("2026-05-30T13:00:00Z"), { dndEnabled: true, dndStart: "09:00", dndEnd: "17:00", dndTimezone: "UTC" })).toBe(true);
  });

  it("same-day window: outside", () => {
    expect(isInQuietHours(at("2026-05-30T18:00:00Z"), { dndEnabled: true, dndStart: "09:00", dndEnd: "17:00", dndTimezone: "UTC" })).toBe(false);
  });

  it("overnight window: inside (after midnight)", () => {
    expect(isInQuietHours(at("2026-05-30T03:00:00Z"), { dndEnabled: true, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "UTC" })).toBe(true);
  });

  it("overnight window: inside (before midnight)", () => {
    expect(isInQuietHours(at("2026-05-30T23:30:00Z"), { dndEnabled: true, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "UTC" })).toBe(true);
  });

  it("overnight window: outside (midday)", () => {
    expect(isInQuietHours(at("2026-05-30T12:00:00Z"), { dndEnabled: true, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "UTC" })).toBe(false);
  });

  it("respects timezone: 03:00 UTC = 23:00 EDT in New York (inside overnight window)", () => {
    expect(isInQuietHours(at("2026-05-30T03:00:00Z"), { dndEnabled: true, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "America/New_York" })).toBe(true);
  });

  it("respects timezone: 18:00 UTC = 14:00 EDT in New York (outside overnight window)", () => {
    expect(isInQuietHours(at("2026-05-30T18:00:00Z"), { dndEnabled: true, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "America/New_York" })).toBe(false);
  });

  it("invalid timezone does not suppress (returns false)", () => {
    expect(isInQuietHours(at("2026-05-30T03:00:00Z"), { dndEnabled: true, dndStart: "22:00", dndEnd: "07:00", dndTimezone: "Not/AZone" })).toBe(false);
  });

  it("zero-length window (start === end) is treated as off", () => {
    expect(isInQuietHours(at("2026-05-30T09:00:00Z"), { dndEnabled: true, dndStart: "09:00", dndEnd: "09:00", dndTimezone: "UTC" })).toBe(false);
  });
});
