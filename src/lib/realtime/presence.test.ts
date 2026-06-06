import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresenceRegistry } from "./presence";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("presence registry", () => {
  it("first connection for a user is an online transition", () => {
    const r = createPresenceRegistry();
    expect(r.connect("u1", 1000)).toBe("online");
    expect(r.isOnline("u1")).toBe(true);
  });

  it("second connection for the same user is not a transition", () => {
    const r = createPresenceRegistry();
    r.connect("u1", 1000);
    expect(r.connect("u1", 1000)).toBeNull();
    expect(r.isOnline("u1")).toBe(true);
  });

  it("disconnect of the last connection is an offline transition", () => {
    const r = createPresenceRegistry();
    r.connect("u1", 1000);
    r.connect("u1", 1000);
    expect(r.disconnect("u1")).toBeNull();
    expect(r.disconnect("u1")).toBe("offline");
    expect(r.isOnline("u1")).toBe(false);
  });

  it("heartbeat refreshes lastSeen so sweep keeps the user online", () => {
    const r = createPresenceRegistry();
    r.connect("u1", 1000);
    r.heartbeat("u1", 50_000);
    const dropped = r.sweep(60_000, 60_000);
    expect(dropped).toEqual([]);
    expect(r.isOnline("u1")).toBe(true);
  });

  it("sweep marks users offline when lastSeen exceeds the timeout", () => {
    const r = createPresenceRegistry();
    r.connect("u1", 1000);
    const dropped = r.sweep(100_000, 60_000);
    expect(dropped).toEqual(["u1"]);
    expect(r.isOnline("u1")).toBe(false);
  });

  it("onlineUserIds returns all currently-online users", () => {
    const r = createPresenceRegistry();
    r.connect("u1", 1000);
    r.connect("u2", 1000);
    r.disconnect("u1");
    expect(r.onlineUserIds().sort()).toEqual(["u2"]);
  });

  it("disconnect of an unknown user is a no-op (null)", () => {
    const r = createPresenceRegistry();
    expect(r.disconnect("ghost")).toBeNull();
  });

  it("heartbeat on an unknown user is a silent no-op", () => {
    const r = createPresenceRegistry();
    r.heartbeat("ghost", 1000);
    expect(r.isOnline("ghost")).toBe(false);
  });
});
