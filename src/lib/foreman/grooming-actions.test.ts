// @vitest-environment node
import { describe, it, expect } from "vitest";
import { pickLatestByDry } from "./grooming-actions";

describe("pickLatestByDry", () => {
  it("finds the latest LIVE event even though live events carry NO dry key (the undo bug)", () => {
    const events = [
      { data: { action: "escalate", dry: true } }, // newest = a dry proposal
      { data: { action: "deliver-close" } }, // a live action — no `dry` key at all
    ];
    expect(pickLatestByDry(events, false)).toBe(events[1]);
  });

  it("finds the latest DRY event", () => {
    const events = [{ data: { action: "deliver-close" } }, { data: { action: "escalate", dry: true } }];
    expect(pickLatestByDry(events, true)).toBe(events[1]);
  });

  it("treats an explicit dry:false the same as a missing key (both are live)", () => {
    const live = { data: { dry: false, action: "requeue" } };
    expect(pickLatestByDry([live], false)).toBe(live);
    expect(pickLatestByDry([live], true)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(pickLatestByDry([{ data: { dry: true } }], false)).toBeNull();
    expect(pickLatestByDry([], true)).toBeNull();
  });
});
