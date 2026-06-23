import { describe, it, expect } from "vitest";
import { normalizeCidr, ipMatchesAny } from "./cidr";

// cidr.ts gates IP-allowlist auth via ipaddr.js. These characterization tests
// pin its security behavior so a dependency bump (ipaddr.js 1.x → 2.x) can't
// silently change how allowlist matching works.

describe("normalizeCidr", () => {
  it("passes through a proper IPv4 CIDR", () => {
    expect(normalizeCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("turns a bare IPv4 address into a /32 host route", () => {
    expect(normalizeCidr("192.168.1.5")).toBe("192.168.1.5/32");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeCidr("  10.0.0.0/8  ")).toBe("10.0.0.0/8");
  });

  it("parses an IPv6 CIDR and preserves the prefix length", () => {
    expect(normalizeCidr("2001:db8::/32")).toMatch(/\/32$/);
  });

  it("turns a bare IPv6 address into a /128 host route", () => {
    expect(normalizeCidr("2001:db8::1")).toMatch(/\/128$/);
  });

  it("rejects unparseable input (anti-lockout guard)", () => {
    expect(normalizeCidr("garbage")).toBeNull();
    expect(normalizeCidr("")).toBeNull();
    expect(normalizeCidr("   ")).toBeNull();
    expect(normalizeCidr("256.1.1.1")).toBeNull();
    expect(normalizeCidr("10.0.0.0/99")).toBeNull();
  });
});

describe("ipMatchesAny", () => {
  it("matches an IPv4 address inside a CIDR range", () => {
    expect(ipMatchesAny("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  });

  it("does not match an IPv4 address outside the range", () => {
    expect(ipMatchesAny("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
  });

  it("matches an exact /32 host route", () => {
    expect(ipMatchesAny("192.168.1.5", ["192.168.1.5/32"])).toBe(true);
  });

  it("matches an IPv6 address inside a CIDR range", () => {
    expect(ipMatchesAny("2001:db8::5", ["2001:db8::/32"])).toBe(true);
  });

  it("does not match an IPv6 address outside the range", () => {
    expect(ipMatchesAny("2001:dead::1", ["2001:db8::/32"])).toBe(false);
  });

  it("does not cross-match an IPv4 client against an IPv6 range", () => {
    expect(ipMatchesAny("10.1.2.3", ["2001:db8::/32"])).toBe(false);
  });

  it("skips malformed CIDR entries and still matches a valid one", () => {
    expect(ipMatchesAny("10.1.2.3", ["garbage", "10.0.0.0/8"])).toBe(true);
  });

  it("returns false for an unparseable client IP", () => {
    expect(ipMatchesAny("not-an-ip", ["10.0.0.0/8"])).toBe(false);
  });

  it("returns false against an empty allowlist", () => {
    expect(ipMatchesAny("10.1.2.3", [])).toBe(false);
  });
});
